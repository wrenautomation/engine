/**
 * A video or podcast on the web read as one markdown document (`VideoRead`). Four
 * readers: a YouTube video from its captions and chapters (yt-dlp) plus a video model's read of
 * the screen; a YouTube video from its URL alone (the model hears and reads it: no download, no
 * home IP); any other video yt-dlp fetches (`watchFile`: an ear and an eye); a podcast
 * episode from its audio URL (fetched, then `hearAudio`). Everything that takes a URL or
 * spawns yt-dlp lives here; the reading over a file is in `watch.ts` and `read.ts`. The video
 * model is Gemini (`geminiVideo`): the one that takes a YouTube URL. Every caller passes its own models
 * and tools. Nothing here touches a database.
 */
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Model, Part } from "@wrenautomation/models";
import type { Ear } from "@wrenautomation/models/hear";
import { readMedia, SHOWN } from "./gemini.js";
import type { VideoInfo } from "./index.js";
import {
  CLIP_S,
  captionsBody,
  hearAudio,
  isoDate,
  type Json3,
  real,
  type VideoRead,
} from "./read.js";
import { type MediaStore, mediaKey } from "./store.js";
import { clock, runFor, sleep, TOOL_MS, waitOutCap } from "./tools.js";
import {
  onScreenLines,
  renderWatched,
  type Watched,
  type WatchOptions,
  watchFile,
} from "./watch.js";

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

/** Where a video comes from, beside yt-dlp: the store, a direct file link, what the caller knows. */
export interface Fetched {
  /** Checked first by `mediaKey(url)`; every fresh download is kept there. */
  store?: MediaStore;
  /** A direct file link (Instagram Graph's `media_url`): fetched before yt-dlp. It expires, so a failed one falls back. */
  mediaUrl?: string;
  /** What the caller knows (Graph's caption, author, date) over what the source gave. */
  meta?: Partial<VideoMeta>;
  fetchFn?: typeof fetch;
  warn?: (line: string) => void;
}

/** 500 MB: past any reel or short. */
const VIDEO_MAX = 500_000_000;

async function fetchFile(link: string, file: string, fetchFn: typeof fetch): Promise<void> {
  const res = await fetchFn(link, { signal: AbortSignal.timeout(TOOL_MS) });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  if (Number(res.headers.get("content-length") ?? 0) > VIDEO_MAX)
    throw new Error(`over ${VIDEO_MAX} bytes`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(file));
}

/**
 * A reel or video as an mp4 in `dir`: the store's copy, else the direct link, else yt-dlp (540p
 * on the short side, remuxed to mp4). A fresh one goes into the store.
 */
export async function download(
  url: string,
  ytDlp: string,
  dir: string,
  o: Fetched = {},
): Promise<{ file: string; info: VideoMeta }> {
  const key = mediaKey(url);
  const warn = o.warn ?? ((line: string) => console.warn(line));
  const file = join(dir, "video.mp4");
  if (o.store && key) {
    const kept = await o.store.get(key, file).catch((err: unknown) => {
      warn(`${key}: store read failed, ${err instanceof Error ? err.message : err}`);
      return null;
    });
    if (kept) return { file, info: { ...kept, ...o.meta } };
  }
  const linked = o.mediaUrl ? await fromLink(url, o.mediaUrl, file, key, o, warn) : null;
  const done = linked ?? (await ytDlpDownload(url, ytDlp, dir, o.meta));
  if (o.store && key)
    await o.store.put(key, done.file, done.info).catch((err: unknown) => {
      warn(`${key}: not kept, ${err instanceof Error ? err.message : err}`);
    });
  return done;
}

async function fromLink(
  url: string,
  link: string,
  file: string,
  key: string | null,
  o: Fetched,
  warn: (line: string) => void,
): Promise<{ file: string; info: VideoMeta } | null> {
  try {
    await fetchFile(link, file, o.fetchFn ?? fetch);
  } catch (err) {
    warn(`${url}: media link failed (${err instanceof Error ? err.message : err}), yt-dlp instead`);
    await rm(file, { force: true });
    return null;
  }
  const [platform, id] = key?.split("/") ?? [];
  const info = {
    id: id ?? createHash("sha256").update(url).digest("hex").slice(0, 16),
    title: url,
    webpage_url: url,
    ...(platform ? { extractor_key: platform } : {}),
    ...o.meta,
  } as VideoMeta;
  return { file, info };
}

async function ytDlpDownload(
  url: string,
  ytDlp: string,
  dir: string,
  meta?: Partial<VideoMeta>,
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
  return { file: join(dir, file), info: { ...(JSON.parse(stdout) as VideoMeta), ...meta } };
}

/**
 * Watch a video: a URL fetched first (`download`: the store, a direct link, or yt-dlp; `ytDlp`
 * is the command, split on spaces: `uvx yt-dlp`), or a file on disk, which goes straight to
 * `watchFile`. A URL's metadata comes back as `info`; a duration ffmpeg could not read falls back to it.
 */
export async function watch(
  input: string,
  opts: WatchOptions & Fetched & { ytDlp?: string },
): Promise<Watched & { info?: VideoMeta }> {
  if (!/^https?:\/\//.test(input)) return watchFile(input, opts);
  const dir = await mkdtemp(join(tmpdir(), "read-watch-"));
  try {
    const { file, info } = await download(input, opts.ytDlp ?? "yt-dlp", dir, opts);
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

/** Caption URLs tried per round; a 429 on all of them is the IP, not the URL. */
const TRACKS_PER_TRY = 3;
/** Waits after a round of 429s, unless YouTube names its own (capped at the longest). */
export const CAPTION_WAITS_MS = [20_000, 60_000, 120_000];

/**
 * The first caption track that answers. YouTube throttles single caption URLs (429) and the same
 * text sits behind several, so a round tries a few; a round of 429s waits and goes again.
 */
async function captionsOf(
  url: string,
  tracks: readonly { url: string }[],
  fetchFn: typeof fetch,
  pause: (ms: number) => Promise<void>,
): Promise<Json3> {
  let last = 0;
  let next = 0;
  for (let round = 0; round <= CAPTION_WAITS_MS.length; round++) {
    let throttled = false;
    let retryAfter: string | null = null;
    for (let i = 0; i < Math.min(TRACKS_PER_TRY, tracks.length); i++) {
      const t = tracks[next++ % tracks.length] as { url: string };
      const res = await fetchFn(t.url);
      last = res.status;
      if (res.ok) return (await res.json()) as Json3;
      if (res.status === 429) {
        throttled = true;
        retryAfter = res.headers.get("retry-after") ?? retryAfter;
      }
    }
    if (!throttled || round === CAPTION_WAITS_MS.length) break;
    const named = retryAfter ? Number(retryAfter) * 1000 : Number.NaN;
    const longest = CAPTION_WAITS_MS.at(-1) as number;
    await pause(
      Number.isFinite(named) ? Math.min(named, longest) : (CAPTION_WAITS_MS[round] as number),
    );
  }
  throw new Error(`${url}: captions fetch HTTP ${last} on ${tracks.length} tracks, after waits`);
}

/**
 * What the video shows on screen (documents, slides, tables, templates), read by `model` straight
 * from the YouTube URL in `CLIP_S` clips. One markdown block per clip, timestamps absolute.
 * Empty with no model.
 */
async function screenText(
  url: string,
  durationS: number,
  model: Model | null | undefined,
  pause: (ms: number) => Promise<void> = sleep,
): Promise<string> {
  if (!model) return "";
  const clips = Array.from({ length: Math.ceil(durationS / CLIP_S) }, (_, i) => i * CLIP_S);
  // a day's quota spent: the clips after it fail at once, no call, no wait
  let spent: string | null = null;
  const read = async (start: number): Promise<string> => {
    try {
      if (spent) throw new Error(spent);
      // a per-minute cap (429) waits it out
      return await waitOutCap(async () => {
        try {
          return await readMedia(
            model,
            [youtubePart(url, start, durationS)],
            (paraphrase) => SHOWN_ASK(start, paraphrase),
            LOW,
          );
        } catch (err) {
          const why = err instanceof Error ? err.message : String(err);
          if (/per ?day/i.test(why)) {
            spent = `day quota spent: ${why}`;
            throw new Error(spent);
          }
          throw err;
        }
      }, pause);
    } catch (err) {
      // One unread clip must not lose the other 23: leave a marker and carry on.
      const why = err instanceof Error ? err.message : String(err);
      // The document is written all the same: its text keeps the marker below at this time.
      console.warn(`${url} ${clock(start)}: a clip left unread by ${model.id} (${why})`);
      return `[${clock(start)}] (not read: ${why})`;
    }
  };
  const out: string[] = [];
  // 2 clips at a time: 4 met the free tier's per-minute cap (11-03)
  for (let i = 0; i < clips.length; i += 2) {
    const texts = await Promise.all(clips.slice(i, i + 2).map(read));
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
  opts: {
    ytDlp: string;
    video?: Model | null;
    fetchFn?: typeof fetch;
    /** For tests: the wait between caption tries. */
    pause?: (ms: number) => Promise<void>;
  },
): Promise<VideoRead> {
  const fetchFn = opts.fetchFn ?? fetch;
  const pause = opts.pause ?? sleep;
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
  const json = await captionsOf(url, tracks, fetchFn, pause);
  let body = captionsBody(info, json);
  const screen = await screenText(url, info.duration ?? 0, opts.video, pause);
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

/**
 * What a YouTube video shows, for the few the agent picks: downloaded by yt-dlp (the stream
 * reads from the home IP even when the caption URLs 429), each frame read by `eye`: its text and
 * what it shows. `words`: the speech too, from the captions, else `ear` hears the audio. Without
 * `words`, the body is the screen alone (the hit has its captions already).
 */
export async function seeYoutube(
  url: string,
  opts: {
    ytDlp: string;
    /** Takes images (Claude). */
    eye: Model;
    ear?: Ear | undefined;
    words?: boolean;
    ffmpeg?: string;
    fetchFn?: typeof fetch;
    pause?: (ms: number) => Promise<void>;
    store?: MediaStore;
  },
): Promise<VideoRead & { heard: boolean }> {
  let words = "";
  let failed: string | null = null;
  if (opts.words)
    words = await readYoutube(url, {
      ytDlp: opts.ytDlp,
      ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
      ...(opts.pause ? { pause: opts.pause } : {}),
    }).then(
      (r) => r.body,
      (err: unknown) => {
        failed = err instanceof Error ? err.message : String(err);
        return "";
      },
    );
  const hear = !!opts.words && !words && !!opts.ear;
  const watched = await watch(url, {
    ytDlp: opts.ytDlp,
    eye: opts.eye,
    look: "all",
    speech: hear,
    ...(hear && opts.ear ? { ear: opts.ear } : {}),
    ...(opts.ffmpeg ? { ffmpeg: opts.ffmpeg } : {}),
    ...(opts.store ? { store: opts.store } : {}),
  });
  const info = watched.info as VideoMeta;
  const said = words
    ? words
    : hear
      ? `## Speech\n\nHeard from the audio (captions: ${failed}).\n\n${watched.speech || "(no speech)"}\n`
      : opts.words
        ? `## Speech\n\nNot read: ${failed}\n`
        : "";
  const lines = onScreenLines(watched).join("\n") || "(nothing on screen)";
  const uploaded = isoDate(info.upload_date);
  return {
    kind: "youtube",
    id: info.id,
    title: info.title,
    url: info.webpage_url ?? url,
    ...(info.channel ? { channel: info.channel } : {}),
    ...(uploaded ? { uploaded } : {}),
    ...(info.duration ? { duration: Math.round(info.duration) } : {}),
    ...(info.thumbnail ? { thumbnail: info.thumbnail } : {}),
    body: `${said}\n## On screen\n\nWhat the video showed, frame by frame: the text, then what the frame shows. A frame like the one before is left out.\n\n${lines}\n`,
    heard: hear,
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
 * Any other video (an Instagram reel, TikTok, X): the store, a direct link, else yt-dlp. No captions there, so
 * `watch` hears the audio and reads the frames (its `video` model adds a read of the whole
 * screen when given). The body holds the caption, then Speech, On screen and Cuts.
 */
export async function readVideo(
  url: string,
  opts: WatchOptions & Fetched & { ytDlp: string },
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
 * A podcast episode heard from its audio URL: downloaded to a temp file, then
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
  const dir = await mkdtemp(join(tmpdir(), "read-audio-"));
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
