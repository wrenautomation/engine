/**
 * What the source readers share: a child tool run with a time limit, and the clock mark.
 * Own file so `watch.ts` and any other reader import the same one.
 */
import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";

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

export const clock = (s: number): string => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const mm = `${m}:${String(sec).padStart(2, "0")}`;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : mm;
};
