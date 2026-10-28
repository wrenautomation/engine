/**
 * Watching a video (designs/2026-10-21-video-watch.md). ffmpeg gives the facts: length,
 * scene cuts, one 360p frame every 2 s, the speech as a small mono mp3. Cohere reads them: the
 * speech with Transcribe, the on-screen text with command-a-vision. Gemini adds its own read of
 * the screen only when a key still works. One core; every caller passes its own keys and tools.
 * Nothing here touches a database.
 *
 * Cohere's vision is weak, so the result keeps what it did not read: a frame with no line is
 * `null`, never filled from its neighbours, and every line carries its ffmpeg frame time.
 */
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { askShown, INLINE_MAX, SHOWN, shrink } from "./gemini.js";
import { clock, runFor, TOOL_MS } from "./tools.js";

const COHERE = "https://api.cohere.com";
const COHERE_SPEECH_MODEL = "cohere-transcribe-03-2026";
export const COHERE_VISION_MODEL = "command-a-vision-07-2025";
/** The text model for asks that need no picture (`video look --with cohere`). */
/** Cohere's text model on its OpenAI-compatible route. */
export const COHERE_TEXT_MODEL = "command-a-03-2025";
/** Cohere takes 25 MB of audio a call; at 48 kbps that is about 70 minutes. */
const COHERE_FILE_MAX = 25_000_000;
const COHERE_CALL_MS = 120_000;
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
  /** What Cohere heard; "" when nobody speaks or speech was not asked for. */
  speech: string;
  frames: Frame[];
  /** Gemini's read of the screen, when a key worked. */
  gemini?: string;
}

export interface WatchOptions {
  cohereKeys: readonly string[];
  /** Optional: their read of the screen is added when one still works. */
  geminiKeys?: readonly string[];
  ffmpeg?: string;
  /** The PySceneDetect command (split on spaces: `uvx scenedetect`); set, its cuts come too (`cutsBy`). */
  sceneDetect?: string;
  fetchFn?: typeof fetch;
  /** False: skip the transcription (the caller has the words already). */
  speech?: boolean;
  /** ISO 639-1 code of the spoken language. */
  language?: string;
  /** Seconds between frames; stretched so a long video stays under `MAX_FRAMES`. */
  everyS?: number;
  /** For tests: stands in for the wait between retries. */
  pause?: (ms: number) => Promise<void>;
}

type Pause = (ms: number) => Promise<void>;
const sleep: Pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** `0:03.2`, a mark with a tenth of a second. */
export function stamp(s: number): string {
  const t = Math.round(s * 10);
  return `${clock(Math.floor(t / 10))}.${t % 10}`;
}

let nextCohere = 0;
/** Keys rotate on these; the rest of the 4xx are our mistake and stop the call. */
const RETRY = new Set([401, 403, 429, 500, 502, 503, 504]);

/**
 * One Cohere call (JSON body or a multipart `FormData`). A bad key (401/403), a limit (429) or a
 * busy server hands the call to the next key, waiting 2 s doubling to 30 s on the last two; any
 * other refusal throws at once. The key goes in a header and never into an error.
 */
export async function cohereCall<T>(
  keys: readonly string[],
  path: string,
  body: object | FormData,
  o: { fetchFn?: typeof fetch; pause?: Pause; label?: string } = {},
): Promise<T> {
  const label = o.label ?? path;
  if (!keys.length) throw new Error(`cohere ${label}: no COHERE keys`);
  const fetchFn = o.fetchFn ?? fetch;
  const pause = o.pause ?? sleep;
  const form = body instanceof FormData;
  let last = "";
  let wait = 2000;
  for (let i = 0; i < Math.max(3, keys.length * 2); i++) {
    const key = keys[nextCohere++ % keys.length] as string;
    let res: Response;
    try {
      res = await fetchFn(`${COHERE}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          ...(form ? {} : { "content-type": "application/json" }),
        },
        body: form ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(COHERE_CALL_MS),
      });
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
      await pause(wait);
      wait = Math.min(wait * 2, 30_000);
      continue;
    }
    const text = await res.text();
    if (res.ok) {
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new Error(`cohere ${label}: answered ${text.slice(0, 80)}, not JSON`);
      }
    }
    last = `HTTP ${res.status} ${text.slice(0, 200)}`;
    if (!RETRY.has(res.status)) throw new Error(`cohere ${label}: ${last}`);
    if (res.status !== 401 && res.status !== 403) {
      await pause(wait);
      wait = Math.min(wait * 2, 30_000);
    }
  }
  throw new Error(`cohere ${label}: every try refused, last ${last}`);
}

/** A chat answer's text. */
export async function cohereChat(
  keys: readonly string[],
  body: object,
  o: Parameters<typeof cohereCall>[3] = {},
): Promise<string> {
  const r = await cohereCall<{ message?: { content?: { text?: string }[] } }>(
    keys,
    "/v2/chat",
    body,
    { label: "chat", ...o },
  );
  return (r.message?.content ?? [])
    .map((c) => c.text ?? "")
    .join("")
    .trim();
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

async function readBatch(
  batch: Shot[],
  keys: readonly string[],
  o: { fetchFn?: typeof fetch; pause?: Pause },
): Promise<Frame[]> {
  const times = batch.map((f) => clock(f.at));
  const ask = (extra: string) =>
    cohereChat(
      keys,
      {
        model: COHERE_VISION_MODEL,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: `${SCREEN_ASK(times)}${extra}` },
              ...batch.map((f) => ({
                type: "image_url",
                image_url: { url: `data:image/jpeg;base64,${f.jpeg.toString("base64")}` },
              })),
            ],
          },
        ],
      },
      { ...o, label: `vision ${times[0]}` },
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
export async function readScreen(
  shots: Shot[],
  keys: readonly string[],
  o: { fetchFn?: typeof fetch; pause?: Pause } = {},
): Promise<Frame[]> {
  const batches: Shot[][] = [];
  for (let i = 0; i < shots.length; i += BATCH) batches.push(shots.slice(i, i + BATCH));
  const out: Frame[] = [];
  const errors: Error[] = [];
  for (let i = 0; i < batches.length; i += BATCHES_AT_ONCE) {
    const group = batches.slice(i, i + BATCHES_AT_ONCE);
    const done = await Promise.allSettled(group.map((b) => readBatch(b, keys, o)));
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
  keys: readonly string[],
  o: { language: string; fetchFn?: typeof fetch; pause?: Pause },
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
  const bytes = await readFile(mp3);
  if (bytes.length > COHERE_FILE_MAX)
    throw new Error(
      `speech: ${(bytes.length / 1e6).toFixed(1)} MB of audio, over Cohere's ${COHERE_FILE_MAX / 1e6} MB`,
    );
  const form = new FormData();
  form.set("model", COHERE_SPEECH_MODEL);
  form.set("language", o.language);
  form.set("file", new Blob([bytes], { type: "audio/mpeg" }), "speech.mp3");
  const r = await cohereCall<{ text?: string }>(keys, "/v2/audio/transcriptions", form, {
    ...o,
    label: "transcribe",
  });
  return (r.text ?? "").trim();
}

// -- Gemini, when it works ---------------------------------------------------------------

const GEMINI_KEY_CHECK = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1";

/** The keys the API still accepts; a revoked fleet gives none, quickly. */
async function liveGeminiKeys(keys: readonly string[], fetchFn: typeof fetch): Promise<string[]> {
  const ok = await Promise.all(
    keys.map((key) =>
      fetchFn(GEMINI_KEY_CHECK, {
        headers: { "x-goog-api-key": key },
        signal: AbortSignal.timeout(15_000),
      }).then(
        (r) => r.ok,
        () => false,
      ),
    ),
  );
  return keys.filter((_, i) => ok[i]);
}

/** Gemini's read of the screen from the video inline, as the SOP reader did before Cohere. Undefined: no key worked, or nothing came back. */
async function geminiScreen(
  file: string,
  dir: string,
  keys: readonly string[],
  o: { ffmpeg: string; fetchFn: typeof fetch; info: Parameters<typeof shrink>[2] },
): Promise<string | undefined> {
  const live = await liveGeminiKeys(keys, o.fetchFn);
  if (!live.length) return undefined;
  let bytes: Buffer = await readFile(file);
  if (bytes.length > INLINE_MAX)
    bytes = await shrink(file, join(dir, "small.mp4"), o.info, o.ffmpeg);
  if (bytes.length > INLINE_MAX) return undefined;
  const video = { inlineData: { mimeType: "video/mp4", data: bytes.toString("base64") } };
  const r = await askShown(
    (paraphrase) => ({
      contents: [
        {
          parts: [
            video,
            {
              text: `${SHOWN(0, paraphrase)} Markdown. If nothing is shown, reply with the single word none.`,
            },
          ],
        },
      ],
    }),
    live,
    o.fetchFn,
    "watch screen",
  );
  if ("unread" in r) {
    console.warn(`gemini watch screen: unread, last ${r.unread}`);
    return undefined;
  }
  return r.text.toLowerCase() === "none" ? undefined : r.text;
}

// -- the core -----------------------------------------------------------------------------

/** `Promise.all` that lets every promise finish before it throws the first failure: nothing still writes into the work directory when it goes. */
async function allSettled<T extends unknown[]>(ps: { [K in keyof T]: Promise<T[K]> }): Promise<T> {
  const done = await Promise.allSettled(ps);
  for (const r of done) if (r.status === "rejected") throw r.reason;
  return done.map((r) => (r as PromiseFulfilledResult<unknown>).value) as T;
}

/** Watch a video file on disk (a URL is fetched first by weaver's `watch`). */
export async function watch(input: string, opts: WatchOptions): Promise<Watched> {
  if (!opts.cohereKeys.length)
    throw new Error(`${input}: needs COHERE keys to read the speech and the screen`);
  const ffmpeg = opts.ffmpeg ?? "ffmpeg";
  const fetchFn = opts.fetchFn ?? fetch;
  const dir = await mkdtemp(join(tmpdir(), "watch-"));
  try {
    const file = resolve(input);
    const facts = await probe(file, ffmpeg).catch((err: Error) => {
      throw new Error(`${input}: ffprobe could not read it (${err.message.split("\n")[0]})`);
    });
    if (!facts.picture) throw new Error(`${input}: no picture to watch`);
    const durationS = facts.durationS;
    const every = Math.max(opts.everyS ?? FRAME_EVERY_S, Math.ceil(durationS / MAX_FRAMES));
    const call = { fetchFn, ...(opts.pause ? { pause: opts.pause } : {}) };
    const psd = async (d: SceneDetector) =>
      opts.sceneDetect ? sceneDetectCuts(file, d, opts.sceneDetect, dir) : [];
    const [c, h, a, f, s, g] = await allSettled<
      [number[], number[], number[], Frame[], string, string | undefined]
    >([
      sceneCuts(file, ffmpeg),
      psd("hash"),
      psd("adaptive"),
      frames(file, dir, every, ffmpeg).then((shots) => readScreen(shots, opts.cohereKeys, call)),
      opts.speech === false || !facts.audio
        ? Promise.resolve("")
        : speech(file, dir, ffmpeg, opts.cohereKeys, { language: opts.language ?? "en", ...call }),
      opts.geminiKeys?.length
        ? geminiScreen(file, dir, opts.geminiKeys, {
            ffmpeg,
            fetchFn,
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
      ...(g ? { gemini: g } : {}),
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
    ...(w.gemini ? [`## On screen (Gemini)\n\n${w.gemini}`] : []),
    `## Cuts\n\n${cutsLine(w)}`,
    // Only a film's page carries the fence: a reel's cuts are the line above.
    ...(w.cutsBy ? [`## Facts\n\n\`\`\`json\n${JSON.stringify(watchFacts(w))}\n\`\`\``] : []),
  ].join("\n\n");
}
