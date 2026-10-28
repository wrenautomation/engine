/**
 * A video or podcast on the web read as one markdown document (falcon's `VideoRead`). Four
 * readers: a YouTube video from its captions and chapters (yt-dlp) plus a video model's read of
 * the screen; a YouTube video from its URL alone (the model hears and reads it: no download, no
 * home IP); any other video yt-dlp fetches (falcon's `watch`: an ear and an eye); a podcast
 * episode from its audio URL (fetched, then falcon's `hearAudio`). Everything that takes a URL or
 * spawns yt-dlp lives here; the reading over a file is falcon's. The video model is Gemini
 * (falcon's `geminiVideo`): the one that takes a YouTube URL. Every caller passes its own models
 * and tools. Nothing here touches a database.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLIP_S,
  captionsBody,
  clock,
  hearAudio,
  isoDate,
  type Json3,
  readMedia,
  real,
  renderWatched,
  runFor,
  SHOWN,
  TOOL_MS,
  type VideoInfo,
  type VideoRead,
  type Watched,
  type WatchOptions,
  watch as watchFile,
} from "@wrenautomation/falcon/video";
import type { Model, Part } from "@wrenautomation/models";

/** What yt-dlp's `-j` prints for a download; only what the readers use. */
export interface VideoMeta
  extends Pick<
    VideoInfo,
    "id" | "title" | "channel" | "upload_date" | "webpage_url" | "duration" | "thumbnail"
  > {
  extractor_key?: string;
  description?: string;
  uploader?: string;
  width?: number;
  height?: number;
}

/** yt-dlp's download of a reel or video: 540p on the short side, remuxed to mp4. */
export async function download(
  url: string,
  ytDlp: string,
  dir: string,
): Promise<{ file: string; info: VideoMeta }> {
  const [cmd, ...pre] = ytDlp.split(/\s+/) as [string, ...string[]];
  const { stdout } = await runFor(
    cmd,
    [
      ...pre,
      ...["-j", "--no-simulate", "--no-warnings", "--no-playlist"],
      // `res` is the short side, so a vertical reel gets 540x960, not its 1080x1920.
      ...["-S", "res:540", "-f", "bv*+ba/b", "--remux-video", "mp4"],
      ...["-o", join(dir, "video.%(ext)s"), url],
    ],
    TOOL_MS,
    { maxBuffer: 256 * 1024 * 1024 },
  );
  const file = (await readdir(dir)).find((f) => f.endsWith(".mp4"));
  if (!file) throw new Error(`${url}: yt-dlp wrote no mp4`);
  return { file: join(dir, file), info: JSON.parse(stdout) as VideoMeta };
}

/**
 * Watch a video: a URL yt-dlp fetches first (`ytDlp` is the command, split on spaces:
 * `uvx yt-dlp`), or a file on disk, which goes straight to falcon's `watch`. A URL's yt-dlp
 * metadata comes back as `info`; a duration ffmpeg could not read falls back to it.
 */
export async function watch(
  input: string,
  opts: WatchOptions & { ytDlp?: string },
): Promise<Watched & { info?: VideoMeta }> {
  if (!/^https?:\/\//.test(input)) return watchFile(input, opts);
  const dir = await mkdtemp(join(tmpdir(), "weaver-watch-"));
  try {
    const { file, info } = await download(input, opts.ytDlp ?? "yt-dlp", dir);
    const watched = await watchFile(file, opts);
    return { ...watched, durationS: watched.durationS || info.duration || 0, info };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const captionTracks = (info: VideoInfo) =>
  [info.subtitles?.en, info.automatic_captions?.en, info.automatic_captions?.["en-orig"]]
    .flatMap((t) => t ?? [])
    .filter((t) => t.ext === "json3");

const SHOWN_ASK = (start: number, paraphrase: boolean) =>
  `${SHOWN(start, paraphrase)} Markdown. If nothing is shown, reply with the single word none.`;

/** A YouTube page as a video part; `clip` reads only that stretch, at half a frame a second. */
const youtubePart = (page: string, start: number | null, durationS: number): Part => ({
  type: "video",
  data: new URL(page),
  mediaType: "video/mp4",
  ...(start === null
    ? {}
    : { clip: { startS: start, endS: Math.min(start + CLIP_S, durationS), fps: 0.5 } }),
});

// Low resolution reads a shown document fine at a quarter of the tokens.
const LOW = { resolution: "low" } as const;

/**
 * What the video shows on screen (documents, slides, tables, templates), read by `model` straight
 * from the YouTube URL in `CLIP_S` clips. One markdown block per clip, timestamps absolute.
 * Empty with no model.
 */
async function screenText(
  url: string,
  durationS: number,
  model: Model | null | undefined,
): Promise<string> {
  if (!model) return "";
  const clips = Array.from({ length: Math.ceil(durationS / CLIP_S) }, (_, i) => i * CLIP_S);
  const read = async (start: number): Promise<string> => {
    try {
      return await readMedia(
        model,
        [youtubePart(url, start, durationS)],
        (paraphrase) => SHOWN_ASK(start, paraphrase),
        LOW,
      );
    } catch (err) {
      // One unread clip must not lose the other 23: leave a marker and carry on.
      const why = err instanceof Error ? err.message : String(err);
      console.warn(`${model.id} ${clock(start)}: unread, ${why}`);
      return `[${clock(start)}] (not read: ${why})`;
    }
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
 * split on spaces: `uvx yt-dlp`). With a `video` model, an `## On screen` section follows: what
 * the video showed, read from the frames, since the captions carry only the speech.
 */
export async function readYoutube(
  url: string,
  opts: { ytDlp: string; video?: Model | null; fetchFn?: typeof fetch },
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
  const screen = await screenText(url, info.duration ?? 0, opts.video);
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
 * A YouTube video read from its URL alone, no download and no home IP: `model` hears the speech
 * and reads the screen in `CLIP_S` clips (one clip when the length isn't known). The title,
 * channel and thumbnail come from YouTube's oEmbed. For a server; a machine with yt-dlp and a
 * home IP reads the captions instead (`readYoutube`).
 */
export async function readYoutubeByUrl(
  url: string,
  opts: {
    /** Takes a YouTube URL as video (`geminiVideo`). */
    model: Model;
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
    const media = [youtubePart(page, start, duration)];
    const label = `${opts.model.id} ${id} ${clock(start ?? 0)}`;
    const [said, screen] = await Promise.all([
      readMedia(opts.model, media, SPEECH, LOW).catch((err: unknown) => {
        throw new Error(`${label} speech: ${err instanceof Error ? err.message : err}`, {
          cause: err,
        });
      }),
      // The screen is extra: a clip it cannot read keeps its speech.
      readMedia(opts.model, media, (p) => SHOWN_ASK(start ?? 0, p), LOW).catch((err: unknown) => {
        console.warn(`${label} screen: unread, ${err instanceof Error ? err.message : err}`);
        return "";
      }),
    ]);
    return { said, screen };
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
 * Any other video `yt-dlp` fetches (an Instagram reel, TikTok, X). No captions there, so falcon's
 * `watch` hears the audio and reads the frames (its `video` model adds a read of the whole
 * screen when given). The body holds the caption, then Speech, On screen and Cuts.
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

/**
 * A podcast episode heard from its audio URL: downloaded to a temp file, then falcon's
 * `hearAudio` (ffmpeg clips, `model` transcribes each). `url` is the episode's page; `title` and
 * `creator` are what its feed said. The id is a hash of the audio URL.
 */
export async function readAudio(
  audioUrl: string,
  opts: {
    url: string;
    title?: string | null;
    creator?: string | null;
    /** Takes audio (`geminiVideo`). */
    model: Model;
    fetchFn?: typeof fetch;
    ffmpeg?: string;
    /** Seconds per clip; `CLIP_S` unless a test cuts a short tone. */
    clipS?: number;
  },
): Promise<VideoRead> {
  const fetchFn = opts.fetchFn ?? fetch;
  const dir = await mkdtemp(join(tmpdir(), "weaver-audio-"));
  try {
    const res = await fetchFn(audioUrl, { signal: AbortSignal.timeout(600_000) });
    if (!res.ok || !res.body) throw new Error(`${audioUrl}: HTTP ${res.status}`);
    if (Number(res.headers.get("content-length") ?? 0) > AUDIO_MAX)
      throw new Error(`${audioUrl}: over ${AUDIO_MAX / 1e6} MB`);
    const whole = join(dir, "episode");
    await writeFile(whole, Buffer.from(await res.arrayBuffer()));
    const id = createHash("sha1").update(audioUrl).digest("hex").slice(0, 12);
    const heard = await hearAudio(whole, {
      model: opts.model,
      ...(opts.ffmpeg ? { ffmpeg: opts.ffmpeg } : {}),
      ...(opts.clipS ? { clipS: opts.clipS } : {}),
      label: id,
    });
    return {
      kind: "podcast",
      id,
      title: opts.title?.trim() || opts.url,
      url: opts.url,
      ...(opts.creator ? { channel: opts.creator } : {}),
      ...(heard.duration ? { duration: heard.duration } : {}),
      body: heard.speech,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
