/**
 * A video or podcast read as one markdown document. Four readers, one shape: a YouTube video
 * from its captions and chapters (yt-dlp) plus Gemini's read of the screen; a YouTube video from
 * its URL alone (Gemini hears and reads it: no download, no home IP); any other video yt-dlp
 * fetches (`watch`: Cohere hears the audio and reads the frames); a podcast episode from its audio
 * file (ffmpeg cuts it into clips, Gemini transcribes each). Every caller passes its own keys and
 * tools. Nothing here touches a database.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askGemini, askShown, SHOWN } from "./gemini.js";
import type { VideoInfo } from "./index.js";
import { clock, run, runFor, TOOL_MS } from "./tools.js";
import { renderWatched, type VideoMeta, type WatchOptions, watch } from "./watch.js";

/** What a reader gives back: where the piece is, and its markdown sections. */
export interface VideoRead {
  /** The platform, lower case: `youtube`, `instagram`, `tiktok`, `podcast` (yt-dlp's extractor key). */
  kind: string;
  /** Its id on the platform; a podcast's is a hash of its audio URL. */
  id: string;
  title: string;
  url: string;
  channel?: string;
  /** YYYY-MM-DD. */
  uploaded?: string;
  /** Seconds, rounded. */
  duration?: number;
  thumbnail?: string;
  /** The sections as markdown, headings at `##`: one per chapter, or Caption, Speech, On screen, Cuts. */
  body: string;
}

/** YouTube's json3 caption track; only what is read. */
export interface Json3 {
  events: { tStartMs: number; segs?: { utf8: string }[] }[];
}

const MARK_EVERY_S = 60;
/** Seconds of video per model call. */
export const CLIP_S = 600;

const isoDate = (d: string | undefined): string | undefined =>
  d?.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");

/** Captions as markdown: a heading per chapter, a `[m:ss]` marker every minute so a reader can cite a moment. */
export function captionsBody(info: VideoInfo, track: Json3): string {
  const chapters = info.chapters?.length
    ? info.chapters
    : [{ start_time: 0, end_time: info.duration ?? Number.POSITIVE_INFINITY, title: info.title }];
  const words = track.events
    .filter((e) => e.segs?.length)
    .map((e) => ({
      t: e.tStartMs / 1000,
      text: (e.segs ?? [])
        .map((s) => s.utf8)
        .join("")
        .replace(/\s+/g, " ")
        .trim(),
    }))
    .filter((w) => w.text);
  return chapters
    .map((c) => {
      const lines: string[] = [];
      let mark = Number.NEGATIVE_INFINITY;
      for (const w of words) {
        if (w.t < c.start_time || w.t >= c.end_time) continue;
        if (w.t - mark >= MARK_EVERY_S) {
          mark = w.t;
          lines.push(`\n[${clock(w.t)}]`);
        }
        lines.push(w.text);
      }
      return `## [${clock(c.start_time)}] ${c.title}\n${lines.join(" ").trim()}\n`;
    })
    .join("\n");
}

const captionTracks = (info: VideoInfo) =>
  [info.subtitles?.en, info.automatic_captions?.en, info.automatic_captions?.["en-orig"]]
    .flatMap((t) => t ?? [])
    .filter((t) => t.ext === "json3");

const SHOWN_ASK = (start: number, paraphrase: boolean) =>
  `${SHOWN(start, paraphrase)} Markdown. If nothing is shown, reply with the single word none.`;

const real = (s: string) => s && s.toLowerCase() !== "none";

/**
 * What the video shows on screen (documents, slides, tables, templates), read by Gemini straight
 * from the YouTube URL in `CLIP_S` clips. One markdown block per clip, timestamps absolute.
 * Empty when `keys` is empty.
 */
async function screenText(
  url: string,
  durationS: number,
  keys: readonly string[],
  fetchFn: typeof fetch,
): Promise<string> {
  if (!keys.length) return "";
  const clips = Array.from({ length: Math.ceil(durationS / CLIP_S) }, (_, i) => i * CLIP_S);
  const read = async (start: number): Promise<string> => {
    const end = Math.min(start + CLIP_S, durationS);
    const body = (paraphrase: boolean) => ({
      contents: [
        {
          parts: [
            {
              fileData: { fileUri: url },
              videoMetadata: { startOffset: `${start}s`, endOffset: `${end}s`, fps: 0.5 },
            },
            { text: SHOWN_ASK(start, paraphrase) },
          ],
        },
      ],
      // Low resolution reads a shown document fine at a quarter of the tokens.
      generationConfig: { mediaResolution: "MEDIA_RESOLUTION_LOW" },
    });
    const r = await askShown(body, keys, fetchFn, clock(start));
    if ("text" in r) return r.text;
    // One unread clip must not lose the other 23: leave a marker and carry on.
    console.warn(`gemini ${clock(start)}: unread, last ${r.unread}`);
    return `[${clock(start)}] (not read: ${r.unread})`;
  };
  const out: string[] = [];
  // 4 clips at a time; limits are per key, so go wider if it ever drags.
  for (let i = 0; i < clips.length; i += 4) {
    const texts = await Promise.all(clips.slice(i, i + 4).map(read));
    out.push(...texts.filter(real));
  }
  return out.join("\n\n");
}

/**
 * A YouTube video from its captions and chapters, through `yt-dlp` (`ytDlp` is the command,
 * split on spaces: `uvx yt-dlp`). With Gemini keys, an `## On screen` section follows: what the
 * video showed, read from the frames, since the captions carry only the speech.
 */
export async function readYoutube(
  url: string,
  opts: { ytDlp: string; geminiKeys?: readonly string[]; fetchFn?: typeof fetch },
): Promise<VideoRead> {
  const fetchFn = opts.fetchFn ?? fetch;
  const [cmd, ...pre] = opts.ytDlp.split(/\s+/) as [string, ...string[]];
  const { stdout } = await runFor(
    cmd,
    [...pre, "-J", "--no-warnings", "--no-playlist", url],
    TOOL_MS,
    { maxBuffer: 256 * 1024 * 1024 },
  );
  const info = JSON.parse(stdout) as VideoInfo;
  const tracks = captionTracks(info);
  if (!tracks.length) throw new Error(`${url}: no English captions (manual or auto) to read`);
  // YouTube throttles single caption URLs (429); the same text sits behind several, so try each.
  let json: Json3 | undefined;
  let last = 0;
  for (const t of tracks) {
    const res = await fetchFn(t.url);
    last = res.status;
    if (!res.ok) continue;
    json = (await res.json()) as Json3;
    break;
  }
  if (!json) throw new Error(`${url}: captions fetch HTTP ${last} on all ${tracks.length} tracks`);
  let body = captionsBody(info, json);
  const screen = await screenText(url, info.duration ?? 0, opts.geminiKeys ?? [], fetchFn);
  if (screen)
    body += `\n## On screen\n\nWhat the video showed (documents, slides, tables, visuals), read from the frames; the transcript above has only the speech.\n\n${screen}\n`;
  const uploaded = isoDate(info.upload_date);
  return {
    kind: "youtube",
    id: info.id,
    title: info.title,
    url: info.webpage_url ?? `https://www.youtube.com/watch?v=${info.id}`,
    ...(info.channel ? { channel: info.channel } : {}),
    ...(uploaded ? { uploaded } : {}),
    ...(info.duration ? { duration: Math.round(info.duration) } : {}),
    ...(info.thumbnail ? { thumbnail: info.thumbnail } : {}),
    body,
  };
}

const SPEECH =
  "Transcribe the speech in this video: every word spoken, in paragraphs, each starting with its [m:ss] video time. Fix only obvious mishearings. Markdown, no heading. If nobody speaks, reply with the single word none.";

/**
 * A YouTube video read from its URL alone, no download and no home IP: Gemini hears the speech
 * and reads the screen in `CLIP_S` clips (one clip when the length isn't known). The title,
 * channel and thumbnail come from YouTube's oEmbed. For a server; a machine with yt-dlp and a
 * home IP reads the captions instead (`readYoutube`).
 */
export async function readYoutubeByUrl(
  url: string,
  opts: {
    geminiKeys: readonly string[];
    fetchFn?: typeof fetch;
    durationS?: number | null | undefined;
  },
): Promise<VideoRead> {
  const fetchFn = opts.fetchFn ?? fetch;
  const id = /(?:v=|youtu\.be\/|shorts\/|live\/)([\w-]{11})/.exec(url)?.[1];
  if (!id) throw new Error(`${url}: not a YouTube video`);
  const page = `https://www.youtube.com/watch?v=${id}`;
  const meta = (await fetchFn(
    `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(page)}`,
  )
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}))) as { title?: string; author_name?: string; thumbnail_url?: string };
  const duration = opts.durationS ?? 0;
  const starts = duration
    ? Array.from({ length: Math.ceil(duration / CLIP_S) }, (_, i) => i * CLIP_S)
    : [null];
  const readClip = async (start: number | null) => {
    const part = {
      fileData: { fileUri: page },
      ...(start === null
        ? {}
        : {
            videoMetadata: {
              startOffset: `${start}s`,
              endOffset: `${Math.min(start + CLIP_S, duration)}s`,
            },
          }),
    };
    const ask = (text: string) => ({
      contents: [{ parts: [part, { text }] }],
      generationConfig: { mediaResolution: "MEDIA_RESOLUTION_LOW" },
    });
    const label = `${id} ${clock(start ?? 0)}`;
    const [said, screen] = await Promise.all([
      askGemini(ask(SPEECH), opts.geminiKeys, fetchFn, `${label} speech`),
      askShown(
        (paraphrase) => ask(SHOWN_ASK(start ?? 0, paraphrase)),
        opts.geminiKeys,
        fetchFn,
        `${label} screen`,
      ),
    ]);
    if ("unread" in said) throw new Error(`gemini ${label} speech: unread, last ${said.unread}`);
    return { said: said.text, screen: "text" in screen ? screen.text : "" };
  };
  const clips: { said: string; screen: string }[] = [];
  // 4 clips at a time, kept in order: a key fleet spreads them.
  for (let i = 0; i < starts.length; i += 4)
    clips.push(...(await Promise.all(starts.slice(i, i + 4).map(readClip))));
  const speech = clips.map((c) => c.said).filter(real);
  const shown = clips.map((c) => c.screen).filter(real);
  return {
    kind: "youtube",
    id,
    title: meta.title?.trim() || page,
    url: page,
    ...(meta.author_name ? { channel: meta.author_name } : {}),
    ...(duration ? { duration: Math.round(duration) } : {}),
    ...(meta.thumbnail_url ? { thumbnail: meta.thumbnail_url } : {}),
    body: `## Speech\n\n${speech.join("\n\n") || "(no speech)"}\n${
      shown.length ? `\n## On screen\n\n${shown.join("\n\n")}\n` : ""
    }`,
  };
}

/**
 * Any other video `yt-dlp` fetches (an Instagram reel, TikTok, X). No captions there, so `watch`
 * hears the audio and reads the frames with Cohere (Gemini adds its read of the screen when a
 * key works). The body holds the caption, then Speech, On screen and Cuts.
 */
export async function readVideo(
  url: string,
  opts: WatchOptions & { ytDlp: string },
): Promise<VideoRead> {
  const watched = await watch(url, opts);
  const info = watched.info as VideoMeta;
  const caption = info.description?.trim() ?? "";
  const by = info.channel ?? info.uploader;
  const uploaded = isoDate(info.upload_date);
  const duration = info.duration ?? watched.durationS;
  return {
    kind: (info.extractor_key ?? "video").toLowerCase(),
    id: info.id,
    title: caption.split("\n")[0]?.slice(0, 100) || info.title,
    url: info.webpage_url ?? url,
    ...(by ? { channel: by } : {}),
    ...(uploaded ? { uploaded } : {}),
    ...(duration ? { duration: Math.round(duration) } : {}),
    ...(info.thumbnail ? { thumbnail: info.thumbnail } : {}),
    body: `${caption ? `## Caption\n\n${caption}\n\n` : ""}${renderWatched(watched)}\n`,
  };
}

const AUDIO_MAX = 600_000_000;

const HEARD = (start: number) =>
  `Transcribe the speech in this podcast audio: every word spoken, in paragraphs, each starting with its time in the episode as [m:ss], or [h:mm:ss] past the hour (this clip starts at ${clock(start)}), and the speaker's name in bold when it's known. Fix only obvious mishearings. Leave out ad reads. Markdown, no heading. If nobody speaks, reply with the single word none.`;

/**
 * A podcast episode heard from its audio file: downloaded, cut by ffmpeg into `CLIP_S` mono
 * clips small enough to send inline (about 2 MB each), and each transcribed by Gemini, 4 at a
 * time, times running on across clips. `url` is the episode's page; `title` and `creator` are
 * what its feed said.
 */
export async function readAudio(
  audioUrl: string,
  opts: {
    url: string;
    title?: string | null;
    creator?: string | null;
    geminiKeys: readonly string[];
    fetchFn?: typeof fetch;
    ffmpeg?: string;
    /** Seconds per clip; `CLIP_S` unless a test cuts a short tone. */
    clipS?: number;
  },
): Promise<VideoRead> {
  if (!opts.geminiKeys.length) throw new Error(`${audioUrl}: needs Gemini keys to transcribe`);
  const clipS = opts.clipS ?? CLIP_S;
  const fetchFn = opts.fetchFn ?? fetch;
  const ffmpeg = opts.ffmpeg ?? "ffmpeg";
  const dir = await mkdtemp(join(tmpdir(), "scribe-audio-"));
  try {
    const res = await fetchFn(audioUrl, { signal: AbortSignal.timeout(600_000) });
    if (!res.ok || !res.body) throw new Error(`${audioUrl}: HTTP ${res.status}`);
    if (Number(res.headers.get("content-length") ?? 0) > AUDIO_MAX)
      throw new Error(`${audioUrl}: over ${AUDIO_MAX / 1e6} MB`);
    const whole = join(dir, "episode");
    await writeFile(whole, Buffer.from(await res.arrayBuffer()));
    await run(
      ffmpeg,
      [
        ...["-hide_banner", "-loglevel", "error", "-i", whole, "-vn", "-ac", "1", "-ar", "16000"],
        ...["-c:a", "libopus", "-b:a", "24k", "-f", "segment", "-segment_time", String(clipS)],
        ...["-reset_timestamps", "1", join(dir, "clip%03d.ogg")],
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    const clips = (await readdir(dir)).filter((f) => f.startsWith("clip")).sort();
    if (!clips.length) throw new Error(`${audioUrl}: ffmpeg cut no clips`);
    const id = createHash("sha1").update(audioUrl).digest("hex").slice(0, 12);
    const hear = async (file: string, i: number) => {
      const data = (await readFile(join(dir, file))).toString("base64");
      const said = await askGemini(
        {
          contents: [
            {
              parts: [{ inlineData: { mimeType: "audio/ogg", data } }, { text: HEARD(i * clipS) }],
            },
          ],
        },
        opts.geminiKeys,
        fetchFn,
        `${id} ${clock(i * clipS)} speech`,
      );
      if ("unread" in said)
        throw new Error(`gemini ${id} ${clock(i * clipS)}: unread, last ${said.unread}`);
      return real(said.text) ? said.text : "";
    };
    const speech: string[] = [];
    for (let i = 0; i < clips.length; i += 4)
      speech.push(...(await Promise.all(clips.slice(i, i + 4).map((f, j) => hear(f, i + j)))));
    const { stdout } = await run(ffmpeg.replace(/ffmpeg$/, "ffprobe"), [
      ...["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", whole],
    ]).catch(() => ({ stdout: "" }));
    const duration = Math.round(Number(stdout.trim()) || 0);
    return {
      kind: "podcast",
      id,
      title: opts.title?.trim() || opts.url,
      url: opts.url,
      ...(opts.creator ? { channel: opts.creator } : {}),
      ...(duration ? { duration } : {}),
      body: `## Speech\n\n${speech.filter(Boolean).join("\n\n") || "(no speech)"}\n`,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
