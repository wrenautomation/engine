/**
 * Gemini, as the video readers ask it: key and model rotation, the on-screen ask, and the 360p copy
 * that fits inline. Own file so `watch.ts` and the SOP reader both import it.
 */
import { readFile } from "node:fs/promises";
import { clock, runFor, TOOL_MS } from "./tools.js";

const GEMINI = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
// Rotated per try: a busy (503) or reciting model hands the ask to the next.
const GEMINI_MODELS = ["gemini-3.8-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite"];

/**
 * What to read off the frames; shared by YouTube clips and downloaded videos. Gemini won't repeat
 * text it knows from the web (RECITATION); `paraphrase` asks for what that text says instead.
 */
export const SHOWN = (start: number, paraphrase: boolean) =>
  `Transcribe in full, verbatim, every document, list, table, slide, template or other text the speaker shows on screen in this clip, each under a [h:mm:ss] heading of the video time it appears (the clip starts at ${clock(start)}). For every image, screenshot, chart, diagram or UI on screen, extract the information it carries, not what it looks like: the text in it, setting names and their values, numbers, prices, limits, labels, before and after states, and what is highlighted, circled, crossed out, ticked or pointed at. Write each as a line starting with its [h:mm:ss] then [visual], stating the fact as a reader would use it ("Instantly warmup settings: daily limit 10, slow ramp on, +1 per day, reply rate 95%"), not "a screenshot of the settings page". Skip visuals that carry no information (decoration, layout, gestures, transitions) and repeats of anything already captured. Skip the speaker's face, chat windows, b-roll and stock footage, and anything already shown earlier in the clip.${paraphrase ? " Where a shown passage is published text (a post, article, page), give its first line word for word, then every point it makes in your own words." : ""}`;

let nextKey = 0;

/** One Gemini call gives up after this long: a stalled socket would wait out undici's 5 minutes, per try. */
const GEMINI_CALL_MS = 180_000;
/** One ask, its retries and backoffs together, gives up after this long. */
const GEMINI_ASK_MS = 360_000;

/**
 * One Gemini call. Keys rotate on 429/403, a busy flash (503) hands to lite, backing off 2s
 * doubling to 1 min. A call that stalls or drops is a refusal too. After 24 refusals, or
 * `askMs` (6 minutes), it returns `unread` with the last one.
 */
export async function askGemini(
  body: unknown,
  keys: readonly string[],
  fetchFn: typeof fetch,
  label: string,
  limits: { callMs?: number; askMs?: number; pause?: (ms: number) => Promise<void> } = {},
): Promise<{ text: string } | { unread: string }> {
  const until = Date.now() + (limits.askMs ?? GEMINI_ASK_MS);
  const pause = limits.pause ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last = "";
  let wait = 2000;
  let recited = 0;
  for (let i = 0; i < 24 && Date.now() < until; i++) {
    const key = keys[nextKey++ % keys.length] as string;
    const model = GEMINI_MODELS[i % GEMINI_MODELS.length] as string;
    let res: Response;
    let json: {
      candidates?: { finishReason?: string; content?: { parts?: { text?: string }[] } }[];
      error?: { message?: string };
    };
    try {
      res = await fetchFn(GEMINI(model), {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(limits.callMs ?? GEMINI_CALL_MS),
      });
      json = (await res.json()) as typeof json;
    } catch (err) {
      last = `${model} ${err instanceof Error ? err.message : String(err)}`;
      await pause(wait);
      wait = Math.min(wait * 2, 60_000);
      continue;
    }
    const text = (json.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? "")
      .join("")
      .trim();
    if (text) return { text };
    const reason = json.candidates?.[0]?.finishReason;
    // Recitation is per model and try, not per key: no backoff, and three strikes go back to the caller.
    if (reason === "RECITATION") {
      if (++recited === 3) return { unread: "RECITATION" };
      continue;
    }
    // A 200 with no text (blocked, cut off) is a refusal too: try the next key and model.
    last = res.ok
      ? `${model} empty, ${reason ?? "no candidate"}`
      : `${model} HTTP ${res.status} ${json.error?.message ?? ""}`.trim();
    if (!res.ok && ![401, 402, 403, 429, 500, 503].includes(res.status))
      throw new Error(`gemini ${label}: ${last}`);
    await pause(wait);
    wait = Math.min(wait * 2, 60_000);
  }
  return { unread: last || "timed out" };
}

/** The on-screen ask, asked again as a paraphrase when Gemini won't recite. */
export async function askShown(
  body: (paraphrase: boolean) => unknown,
  keys: readonly string[],
  fetchFn: typeof fetch,
  label: string,
): Promise<{ text: string } | { unread: string }> {
  const r = await askGemini(body(false), keys, fetchFn, label);
  return "unread" in r && r.unread === "RECITATION"
    ? askGemini(body(true), keys, fetchFn, label)
    : r;
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
  ffmpeg = process.env.WREN_FFMPEG ?? "ffmpeg",
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
