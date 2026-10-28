/**
 * Gemini, as the video readers ask it: the reader over a key ring, one read of media with the
 * paraphrase retry, the on-screen ask, and the 360p copy that fits inline. Every call goes through
 * `@wrenautomation/models`.
 */
import { readFile } from "node:fs/promises";
import {
  fallback,
  gemini,
  geminiLiveKeys,
  isCut,
  isFiltered,
  type Model,
  type Part,
} from "@wrenautomation/models";
import { clock, runFor, TOOL_MS } from "./tools.js";

/** Newest first: a busy or refused model hands the call to the next. */
export const GEMINI_MODELS = ["gemini-3.8-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite"];
/** One call gives up after this long: a stalled socket would wait out undici's 5 minutes. */
const CALL_MS = 180_000;
/** One read, every model, key and pass together, gives up after this long. */
export const READ_MS = 360_000;
/** The answer's ceiling: a 10-minute clip's text runs long. A cut answer keeps what it said. */
export const READ_TOKENS = 32_000;

/**
 * What to read off the frames; shared by YouTube clips and downloaded videos. Gemini won't repeat
 * text it knows from the web (RECITATION); `paraphrase` asks for what that text says instead.
 */
export const SHOWN = (start: number, paraphrase: boolean) =>
  `Transcribe in full, verbatim, every document, list, table, slide, template or other text the speaker shows on screen in this clip, each under a [h:mm:ss] heading of the video time it appears (the clip starts at ${clock(start)}). For every image, screenshot, chart, diagram or UI on screen, extract the information it carries, not what it looks like: the text in it, setting names and their values, numbers, prices, limits, labels, before and after states, and what is highlighted, circled, crossed out, ticked or pointed at. Write each as a line starting with its [h:mm:ss] then [visual], stating the fact as a reader would use it ("Instantly warmup settings: daily limit 10, slow ramp on, +1 per day, reply rate 95%"), not "a screenshot of the settings page". Skip visuals that carry no information (decoration, layout, gestures, transitions) and repeats of anything already captured. Skip the speaker's face, chat windows, b-roll and stock footage, and anything already shown earlier in the clip.${paraphrase ? " Where a shown passage is published text (a post, article, page), give its first line word for word, then every point it makes in your own words." : ""}`;

/**
 * The video reader on a Gemini key ring: `GEMINI_MODELS` in turn, each over every key that still
 * works, three passes while they only say "later". Null when no key works: a revoked fleet must
 * not get a 14 MB inline body posted to each key.
 */
export async function geminiVideo(
  keys: readonly string[],
  o: { fetch?: typeof fetch } = {},
): Promise<Model | null> {
  const live = await geminiLiveKeys(keys, o);
  if (!live.length) return null;
  const wire = o.fetch ? { fetch: o.fetch } : {};
  return fallback(
    GEMINI_MODELS.map((model) => gemini({ key: live, model, limitMs: CALL_MS, ...wire })),
    { passes: 3 },
  );
}

/**
 * One read of media: the parts, then the ask. An answer the output cap cut keeps what it said. A
 * Filtered stop (RECITATION: Gemini won't repeat text it knows from the web) is asked once more
 * with `paraphrase`, on the same model list from the top: a fallback does not rotate on Filtered,
 * since the next model knows the same web. A plain string ask has no paraphrase; Filtered throws.
 */
export async function readMedia(
  model: Model,
  media: readonly Part[],
  ask: string | ((paraphrase: boolean) => string),
  o: { resolution?: "low" | "medium" | "high" } = {},
): Promise<string> {
  const once = async (paraphrase: boolean) => {
    try {
      const r = await model.complete({
        prompt: [...media, { type: "text", text: typeof ask === "string" ? ask : ask(paraphrase) }],
        maxTokens: READ_TOKENS,
        signal: AbortSignal.timeout(READ_MS),
        ...(o.resolution ? { resolution: o.resolution } : {}),
      });
      return r.text.trim();
    } catch (err) {
      if (isCut(err)) return err.partial.trim();
      throw err;
    }
  };
  try {
    return await once(false);
  } catch (err) {
    if (!isFiltered(err) || typeof ask === "string") throw err;
    console.warn(`${model.id}: stopped (${err.stop}); asking for a paraphrase`);
    return once(true);
  }
}

// Gemini takes 20 MB a request inline, and base64 adds a third.
export const INLINE_MAX = 14_000_000;

/**
 * A video re-encoded to fit `INLINE_MAX`: short side 360, 15 fps, mono speech, and a bitrate
 * that spends 85% of the cap over its length (four minutes when yt-dlp didn't say).
 */
export async function shrink(
  src: string,
  out: string,
  info: { duration?: number; width?: number; height?: number },
  ffmpeg = "ffmpeg",
): Promise<Buffer> {
  const seconds = info.duration && info.duration > 0 ? info.duration : 240;
  const audio = 48_000;
  const video = Math.max(120_000, Math.floor((INLINE_MAX * 8 * 0.85) / seconds - audio));
  const tall = (info.height ?? 1) >= (info.width ?? 0);
  await runFor(
    ffmpeg,
    [
      ...["-y", "-loglevel", "error", "-i", src],
      ...["-vf", tall ? "scale=360:-2" : "scale=-2:360", "-r", "15"],
      ...["-c:v", "libx264", "-preset", "veryfast", "-b:v", String(video)],
      ...["-maxrate", String(video), "-bufsize", String(video * 2)],
      ...["-c:a", "aac", "-b:a", String(audio), "-ac", "1"],
      ...["-movflags", "+faststart", out],
    ],
    TOOL_MS,
  );
  return readFile(out);
}
