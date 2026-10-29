/**
 * Watching a video (designs/2026-10-21-video-watch.md). ffmpeg gives the facts: length,
 * scene cuts, one 360p frame every 2 s, the speech as a small mono mp3. Models read them: an ear
 * hears the speech (Cohere's Transcribe), an eye reads the frames as images (command-a-vision),
 * and a model that takes video (Gemini) may read the whole of it too. One core; every caller
 * passes its own models and tools. Nothing here touches a database.
 *
 * Cohere's vision is weak, so the result keeps what it did not read: a frame with no line is
 * `null`, never filled from its neighbours, and every line carries its ffmpeg frame time.
 */
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cohere, type Model, type RotateOptions } from "@wrenautomation/models";
import { cohereEar, type Ear } from "@wrenautomation/models/hear";
import { INLINE_MAX, readMedia, SHOWN, shrink } from "./gemini.js";
import { clock, runFor, TOOL_MS } from "./tools.js";

export const COHERE_VISION_MODEL = "command-a-vision-07-2025";
/** The text model for asks that need no picture (`video look --with cohere`). */
export const COHERE_TEXT_MODEL = "command-a-03-2025";
/** Trial keys allow about 20 calls a minute: wait out a busy ring, 2 s doubling to 30 s. */
const COHERE_ROTATE: RotateOptions = { passes: 4, waitMs: 2000, maxWaitMs: 30_000 };
/** Frames per vision call. */
const BATCH = 8;
/** Vision calls at one time; trial keys allow about 20 calls a minute. */
const BATCHES_AT_ONCE = 3;
/** ffmpeg's scene score above which a frame starts a new shot. */
const SCENE = 0.25;
const FRAME_EVERY_S = 2;
/** A longer video gets its frames further apart, not more of them. */
const MAX_FRAMES = 300;

export interface Frame {
  /** Seconds into the video, from the ffmpeg frame grid. */
  at: number;
  text: string | null;
}

/** PySceneDetect's detectors: `hash` is the one films trust, `adaptive` the second signal. */
export const SCENE_DETECTORS = ["hash", "adaptive"] as const;
export type SceneDetector = (typeof SCENE_DETECTORS)[number];

export interface Watched {
  durationS: number;
  /** Scene cuts ffmpeg found, in seconds. */
  cuts: number[];
  /** PySceneDetect's cuts by detector; only with `sceneDetect`. */
  cutsBy?: Record<SceneDetector, number[]>;
  /** Whether the file has a sound track at all. */
  audio: boolean;
  /** What the ear heard; "" when nobody speaks or speech was not asked for. */
  speech: string;
  frames: Frame[];
  /** The video model's read of the whole screen, when one was given and it answered. */
  whole?: string;
}

export interface WatchOptions {
  /** Reads the frames, `BATCH` images a call (`cohereEye`). */
  eye: Model;
  /** Hears the speech (`cohereEar` from models). None: no transcript. */
  ear?: Ear;
  /** Optional: reads the whole video for what it shows (`geminiVideo`). It must take video. */
  video?: Model | null;
  ffmpeg?: string;
  /** The PySceneDetect command (split on spaces: `uvx scenedetect`); set, its cuts come too (`cutsBy`). */
  sceneDetect?: string;
  /** False: skip the transcription (the caller has the words already). */
  speech?: boolean;
  /** ISO 639-1 code of the spoken language. */
  language?: string;
  /** Seconds between frames; stretched so a long video stays under `MAX_FRAMES`. */
  everyS?: number;
}

/** Cohere's vision model on a key ring, waiting out a busy ring. */
export const cohereEye = (keys: readonly string[], o: { fetch?: typeof fetch } = {}): Model =>
  cohere({ key: keys, model: COHERE_VISION_MODEL, rotate: COHERE_ROTATE, ...o });

/** Cohere's Transcribe on a key ring, waiting out a busy ring. */
export const cohereSpeech = (keys: readonly string[], o: { fetch?: typeof fetch } = {}): Ear =>
  cohereEar({ key: keys, rotate: COHERE_ROTATE, ...o });

/** `0:03.2`, a mark with a tenth of a second. */
export function stamp(s: number): string {
  const t = Math.round(s * 10);
  return `${clock(Math.floor(t / 10))}.${t % 10}`;
}

// -- the screen ---------------------------------------------------------------------------

const SCREEN_ASK = (times: string[]) =>
  `These are ${times.length} frames from one video, in order. Their times: ${times.join(", ")}. Read the text shown in each frame: captions, titles, slide and UI text, labels, numbers. Reply with exactly one line per frame, starting with its time in square brackets, like "[${times[0]}] text". Write "[${times[0]}] none" for a frame with no text. No other text.`;

/** Added to the ask once, when the model would not describe a frame. */
const TEXT_ONLY = "Read only on-screen text, UI and graphics. Ignore people.";

/** The model declining ("I can't assist with describing images of people"), as opposed to reading. */
const REFUSAL =
  /\bi(?:'|’)?m (?:sorry|unable|not able)|\bi am (?:sorry|unable|not able)|\bunable to (?:assist|help|describe|identify|process|provide|analy[sz]e)|\b(?:can(?:'|’)?t|cannot|can not|won(?:'|’)?t|not able to)\s+(?:\w+\s+){0,3}(?:assist|help|describe|identify|process|provide|analy[sz]e|comply)/i;
const LINE = /^[\s*•-]*\[?(\d+(?::\d{2}){1,2})\]?\s*[:–—-]?\s*(.*)$/;
const NONE = /^(?:none|no text|n\/a|-)\.?$/i;

/**
 * The lines of an answer by frame time. A time that is not in the batch is dropped; the first
 * line for a time wins; a refusing line is dropped. `refused`: the model declined, in a line or
 * as the whole answer.
 */
function parseScreen(answer: string, times: ReadonlySet<string>) {
  const lines = new Map<string, string>();
  let refused = false;
  for (const raw of answer.split("\n")) {
    const m = LINE.exec(raw);
    if (!m || !times.has(m[1] as string) || lines.has(m[1] as string)) continue;
    const text = (m[2] ?? "").trim();
    if (REFUSAL.test(text.slice(0, 80))) refused = true;
    else lines.set(m[1] as string, NONE.test(text) ? "" : text);
  }
  if (!lines.size && REFUSAL.test(answer)) refused = true;
  return { lines, refused };
}

type Shot = { at: number; jpeg: Buffer };

async function readBatch(batch: Shot[], eye: Model): Promise<Frame[]> {
  const times = batch.map((f) => clock(f.at));
  const ask = (extra: string) =>
    eye
      .complete({
        prompt: [
          { type: "text", text: `${SCREEN_ASK(times)}${extra}` },
          ...batch.map((f) => ({ type: "image" as const, data: f.jpeg, mediaType: "image/jpeg" })),
        ],
      })
      .then(
        (r) => r.text,
        (err: unknown) => {
          const why = err instanceof Error ? err.message : String(err);
          throw new Error(`${eye.id} ${times[0]}: ${why}`, { cause: err });
        },
      );
  const first = parseScreen(await ask(""), new Set(times));
  if (first.refused) {
    // Once more, told to leave people out. A frame the first answer read keeps its line.
    const again = parseScreen(await ask(` ${TEXT_ONLY}`), new Set(times));
    for (const [t, text] of again.lines) if (!first.lines.has(t)) first.lines.set(t, text);
  }
  // A time with no line stays null: not read. Never filled from the frames around it.
  return batch.map((f, i) => ({ at: f.at, text: first.lines.get(times[i] as string) ?? null }));
}

/**
 * On-screen text for each frame, `BATCH` frames a call, `BATCHES_AT_ONCE` calls at a time. A
 * batch that cannot be asked at all leaves its frames unread (and a warning); all of them
 * failing throws.
 */
export async function readScreen(shots: Shot[], eye: Model): Promise<Frame[]> {
  const batches: Shot[][] = [];
  for (let i = 0; i < shots.length; i += BATCH) batches.push(shots.slice(i, i + BATCH));
  const out: Frame[] = [];
  const errors: Error[] = [];
  for (let i = 0; i < batches.length; i += BATCHES_AT_ONCE) {
    const group = batches.slice(i, i + BATCHES_AT_ONCE);
    const done = await Promise.allSettled(group.map((b) => readBatch(b, eye)));
    for (const [j, r] of done.entries()) {
      if (r.status === "fulfilled") {
        out.push(...r.value);
        continue;
      }
      const err = r.reason instanceof Error ? r.reason : new Error(String(r.reason));
      errors.push(err);
      console.warn(`${err.message}; frames from ${clock(group[j]?.[0]?.at ?? 0)} not read`);
      out.push(...(group[j] ?? []).map((f) => ({ at: f.at, text: null })));
    }
  }
  if (batches.length && errors.length === batches.length) throw errors[0];
  return out;
}

// -- ffmpeg -------------------------------------------------------------------------------

interface Facts {
  durationS: number;
  audio: boolean;
  picture: boolean;
  width?: number;
  height?: number;
}

async function probe(file: string, ffmpeg: string): Promise<Facts> {
  const { stdout } = await runFor(
    ffmpeg.replace(/ffmpeg$/, "ffprobe"),
    [
      ...["-v", "error", "-of", "json", file],
      ...["-show_entries", "format=duration:stream=codec_type,width,height"],
    ],
    TOOL_MS,
  );
  const j = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: { codec_type?: string; width?: number; height?: number }[];
  };
  const picture = (j.streams ?? []).find((s) => s.codec_type === "video");
  return {
    durationS: Number(j.format?.duration) || 0,
    audio: (j.streams ?? []).some((s) => s.codec_type === "audio"),
    picture: !!picture,
    ...(picture?.width ? { width: picture.width } : {}),
    ...(picture?.height ? { height: picture.height } : {}),
  };
}

/** Frame `i` (from 0) is at `i * every`. Short side 360, so a wide screen recording stays readable. */
async function frames(file: string, dir: string, every: number, ffmpeg: string): Promise<Shot[]> {
  const out = join(dir, "frames");
  await mkdir(out);
  const scale = "scale='if(gt(iw,ih),-2,360)':'if(gt(iw,ih),360,-2)'";
  await runFor(
    ffmpeg,
    [
      ...["-hide_banner", "-loglevel", "error", "-i", file, "-an"],
      ...["-vf", `fps=1/${every},${scale}`, "-q:v", "5", join(out, "%03d.jpg")],
    ],
    TOOL_MS,
  );
  const names = (await readdir(out)).filter((n) => n.endsWith(".jpg")).sort();
  return Promise.all(
    names.map(async (n, i) => ({ at: i * every, jpeg: await readFile(join(out, n)) })),
  );
}

/** Cut times from a `list-scenes` CSV (`--skip-cuts`: the header, then one row a scene). Each scene after the first starts on a cut. */
export function parseScenes(csv: string): number[] {
  const rows = csv.trim().split("\n");
  const col = (rows[0] ?? "").split(",").indexOf("Start Time (seconds)");
  if (col < 0) return [];
  return rows
    .slice(2)
    .map((r) => Math.round(Number(r.split(",")[col]) * 100) / 100)
    .filter((n) => Number.isFinite(n));
}

/** PySceneDetect's cuts by one detector. ffmpeg's `scene` misses a fade and a card swap on black; `hash` finds them (designs/studies/2026-10-25-launch-films.md). */
export async function sceneDetectCuts(
  file: string,
  detector: SceneDetector,
  cmd: string,
  dir: string,
): Promise<number[]> {
  const [bin, ...pre] = cmd.split(/\s+/) as [string, ...string[]];
  const name = `scenes-${detector}.csv`;
  await runFor(
    bin,
    [
      ...pre,
      "-q",
      "-i",
      file,
      `detect-${detector}`,
      "list-scenes",
      "-o",
      dir,
      "-f",
      name,
      "--skip-cuts",
    ],
    TOOL_MS,
  );
  return parseScenes(await readFile(join(dir, name), "utf8"));
}

/** Shot changes: the frames `select` keeps are logged by `showinfo`, on stderr. */
export async function sceneCuts(file: string, ffmpeg: string): Promise<number[]> {
  const { stderr } = await runFor(
    ffmpeg,
    [
      ...["-hide_banner", "-nostats", "-i", file, "-an"],
      ...["-vf", `select='gt(scene,${SCENE})',showinfo`, "-f", "null", "-"],
    ],
    TOOL_MS,
    { maxBuffer: 64 * 1024 * 1024 },
  );
  return [...stderr.matchAll(/pts_time:(\d+(?:\.\d+)?)/g)].map(
    (m) => Math.round(Number(m[1]) * 100) / 100,
  );
}

async function speech(
  file: string,
  dir: string,
  ffmpeg: string,
  ear: Ear,
  o: { language: string; seconds: number },
): Promise<string> {
  const mp3 = join(dir, "speech.mp3");
  await runFor(
    ffmpeg,
    [
      ...["-hide_banner", "-loglevel", "error", "-y", "-i", file, "-vn"],
      ...["-ac", "1", "-ar", "16000", "-b:a", "48k", mp3],
    ],
    TOOL_MS,
  );
  const heard = await ear.hear(
    { data: await readFile(mp3), mediaType: "audio/mpeg", filename: "speech.mp3" },
    o,
  );
  return heard.text.trim();
}

// -- the whole video ---------------------------------------------------------------------

/** The video model's read of the screen from the file inline. Undefined: too large, or nothing came back. */
async function wholeScreen(
  file: string,
  dir: string,
  video: Model,
  o: { ffmpeg: string; info: Parameters<typeof shrink>[2] },
): Promise<string | undefined> {
  let bytes: Buffer = await readFile(file);
  if (bytes.length > INLINE_MAX)
    bytes = await shrink(file, join(dir, "small.mp4"), o.info, o.ffmpeg);
  if (bytes.length > INLINE_MAX) return undefined;
  try {
    const text = await readMedia(
      video,
      [{ type: "video", data: bytes, mediaType: "video/mp4" }],
      (paraphrase) =>
        `${SHOWN(0, paraphrase)} Markdown. If nothing is shown, reply with the single word none.`,
    );
    return text && text.toLowerCase() !== "none" ? text : undefined;
  } catch (err) {
    console.warn(`${video.id} watch screen: not read, ${err instanceof Error ? err.message : err}`);
    return undefined;
  }
}

// -- the core -----------------------------------------------------------------------------

/** `Promise.all` that lets every promise finish before it throws the first failure: nothing still writes into the work directory when it goes. */
async function allSettled<T extends unknown[]>(ps: { [K in keyof T]: Promise<T[K]> }): Promise<T> {
  const done = await Promise.allSettled(ps);
  for (const r of done) if (r.status === "rejected") throw r.reason;
  return done.map((r) => (r as PromiseFulfilledResult<unknown>).value) as T;
}

/** Watch a video file on disk (a URL is fetched first by `watch` in `url.ts`). */
export async function watchFile(input: string, opts: WatchOptions): Promise<Watched> {
  if (opts.video && !opts.video.takes.has("video"))
    throw new Error(`${input}: ${opts.video.id} takes no video; pass it as the eye`);
  const ffmpeg = opts.ffmpeg ?? "ffmpeg";
  const dir = await mkdtemp(join(tmpdir(), "watch-"));
  try {
    const file = resolve(input);
    const facts = await probe(file, ffmpeg).catch((err: Error) => {
      throw new Error(`${input}: ffprobe could not read it (${err.message.split("\n")[0]})`);
    });
    if (!facts.picture) throw new Error(`${input}: no picture to watch`);
    const durationS = facts.durationS;
    const every = Math.max(opts.everyS ?? FRAME_EVERY_S, Math.ceil(durationS / MAX_FRAMES));
    const psd = async (d: SceneDetector) =>
      opts.sceneDetect ? sceneDetectCuts(file, d, opts.sceneDetect, dir) : [];
    const [c, h, a, f, s, g] = await allSettled<
      [number[], number[], number[], Frame[], string, string | undefined]
    >([
      sceneCuts(file, ffmpeg),
      psd("hash"),
      psd("adaptive"),
      frames(file, dir, every, ffmpeg).then((shots) => readScreen(shots, opts.eye)),
      opts.speech === false || !facts.audio || !opts.ear
        ? Promise.resolve("")
        : speech(file, dir, ffmpeg, opts.ear, {
            language: opts.language ?? "en",
            seconds: durationS,
          }),
      opts.video
        ? wholeScreen(file, dir, opts.video, {
            ffmpeg,
            info: {
              duration: durationS,
              ...(facts.width ? { width: facts.width } : {}),
              ...(facts.height ? { height: facts.height } : {}),
            },
          }).catch(() => undefined)
        : Promise.resolve(undefined),
    ]);
    return {
      durationS: Math.round(durationS * 100) / 100,
      cuts: c,
      ...(opts.sceneDetect ? { cutsBy: { hash: h, adaptive: a } } : {}),
      audio: facts.audio,
      speech: s,
      frames: f,
      ...(g ? { whole: g } : {}),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// -- the page -----------------------------------------------------------------------------

/** The frames with something to say, each under its ffmpeg frame time; the unread ones say so. */
export function onScreenLines(w: Pick<Watched, "frames">): string[] {
  return w.frames.flatMap((f) =>
    f.text === null
      ? [`[${clock(f.at)}] (not read)`]
      : f.text
        ? [`[${clock(f.at)}] ${f.text}`]
        : [],
  );
}

export const cutsLine = (w: Pick<Watched, "cuts">): string =>
  w.cuts.length ? w.cuts.map(stamp).join(", ") : "(none)";

/** `read`, `unread`: how many frames the model returned a line for. */
export function frameCounts(w: Pick<Watched, "frames">) {
  const unread = w.frames.filter((f) => f.text === null).length;
  return { read: w.frames.length - unread, unread };
}

/** The `## Speech`, `## On screen` and `## Cuts` sections; the CLI prints it and a SOP source holds it. */
/** What a film's facts are read from later: the length, the sound track, every detector's cuts. */
export interface WatchFacts {
  duration_s: number;
  audio: boolean;
  cuts_by: { ffmpeg: number[] } & Partial<Record<SceneDetector, number[]>>;
}

export const watchFacts = (
  w: Pick<Watched, "durationS" | "audio" | "cuts" | "cutsBy">,
): WatchFacts => ({
  duration_s: w.durationS,
  audio: w.audio,
  cuts_by: { ffmpeg: w.cuts, ...(w.cutsBy ?? {}) },
});

/** The facts fence of a rendered page, when it has one. */
export function readWatchFacts(md: string): WatchFacts | null {
  const m = /## Facts\n\n```json\n([\s\S]*?)\n```/.exec(md);
  if (!m) return null;
  try {
    return JSON.parse(m[1] as string) as WatchFacts;
  } catch {
    return null;
  }
}

export function renderWatched(w: Watched): string {
  const screen = onScreenLines(w).join("\n") || "(no text on screen)";
  return [
    `## Speech\n\n${w.speech || "(no speech)"}`,
    `## On screen\n\n${screen}`,
    ...(w.whole ? [`## On screen (whole video)\n\n${w.whole}`] : []),
    `## Cuts\n\n${cutsLine(w)}`,
    // Only a film's page carries the fence: a reel's cuts are the line above.
    ...(w.cutsBy ? [`## Facts\n\n\`\`\`json\n${JSON.stringify(watchFacts(w))}\n\`\`\``] : []),
  ].join("\n\n");
}
