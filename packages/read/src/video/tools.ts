/**
 * What the source readers share: a child tool run with a time limit, and the clock mark.
 * Own file so `watch.ts` and any other reader import the same one.
 */
import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import { isTransient } from "@wrenautomation/models";

export const run = promisify(execFile);

/** yt-dlp's metadata call, or a download and remux of a reel, past this is stuck. */
export const TOOL_MS = 300_000;

/** Run a tool; past `ms` it is killed and the error says which tool and how long. */
export async function runFor(
  cmd: string,
  args: string[],
  ms: number,
  opts: { maxBuffer?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await run(cmd, args, { ...opts, timeout: ms, killSignal: "SIGKILL" });
  } catch (err) {
    if ((err as { killed?: boolean }).killed)
      throw new Error(`${basename(cmd)} timed out after ${Math.round(ms / 1000)}s`);
    throw err;
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A per-minute cap with no `retry-after`: wait it out this long, at most `CAP_WAITS` times a call. */
export const CAP_WAIT_MS = 61_000;
export const CAP_WAITS = 3;

/** `fn`, again after the vendor's wait (a minute when it names none) each time it says "later". */
export async function waitOutCap<T>(
  fn: () => Promise<T>,
  pause: (ms: number) => Promise<void> = sleep,
): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= CAP_WAITS || !isTransient(err)) throw err;
      const until = err.retryAfter ? Date.parse(err.retryAfter) - Date.now() : Number.NaN;
      await pause(Number.isNaN(until) ? CAP_WAIT_MS : Math.max(0, Math.min(until, CAP_WAIT_MS)));
    }
  }
}

export const clock = (s: number): string => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const mm = `${m}:${String(sec).padStart(2, "0")}`;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : mm;
};
