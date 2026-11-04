/**
 * A local ear: whisper.cpp (`brew install whisper-cpp`) on this Mac's GPU, large-v3-turbo q5_0.
 * Free, no rate limit, no network. 11-03, 5 real 60 s clips on an M2 Pro: 20 s, 0.9 GB peak, the
 * same words as the full model (1.9 GB). 10-min clips lost half the words; VAD gave none.
 */
import { existsSync } from "node:fs";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Ear } from "@wrenautomation/models/hear";
import { runFor, TOOL_MS } from "./tools.js";
import { cohereSpeech } from "./watch.js";

/** Shared with wren studio's word timings. */
export const WHISPER_DIR = join(homedir(), ".cache/wren/whisper");
export const WHISPER_MODEL = join(WHISPER_DIR, "ggml-large-v3-turbo-q5_0.bin");
const MODEL_URL =
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin";

const EXT: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/flac": "flac",
  "audio/ogg": "ogg",
};

const exists = (f: string) =>
  access(f).then(
    () => true,
    () => false,
  );

export interface WhisperOptions {
  bin?: string;
  model?: string;
  /** For tests: a stand-in for the binary. */
  run?: typeof runFor;
}

/** The binary runs and the model is on disk. */
export async function whisperReady(o: WhisperOptions = {}): Promise<boolean> {
  if (!(await exists(o.model ?? WHISPER_MODEL))) return false;
  return (o.run ?? runFor)(o.bin ?? "whisper-cli", ["--help"], 10_000).then(
    () => true,
    () => false,
  );
}

/** whisper.cpp as an `Ear`. */
export function whisperSpeech(o: WhisperOptions = {}): Ear {
  const bin = o.bin ?? "whisper-cli";
  const model = o.model ?? WHISPER_MODEL;
  const run = o.run ?? runFor;
  return {
    id: "local:whisper-large-v3-turbo",
    model: "whisper-large-v3-turbo",
    async hear(audio, h = {}) {
      if (!(await exists(model)))
        throw new Error(`whisper: no model at ${model}; download ${MODEL_URL}`);
      const dir = await mkdtemp(join(tmpdir(), "whisper-"));
      const started = performance.now();
      try {
        const file = join(dir, `in.${EXT[audio.mediaType] ?? "mp3"}`);
        await writeFile(file, audio.data);
        const { stdout } = await run(
          bin,
          [...["-m", model, "-l", h.language ?? "en", "-nt", "-np"], ...["-f", file]],
          TOOL_MS,
          { maxBuffer: 32 * 1024 * 1024 },
        );
        const text = stdout
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .join(" ");
        return {
          text,
          model: "whisper-large-v3-turbo",
          ms: Math.round(performance.now() - started),
          usd: 0,
          free: true,
        };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

/**
 * The ear for this machine: local whisper when its model is on disk (free, no limit), else Cohere
 * on `cohereKeys` (20 calls a minute and a monthly cap, per org). Undefined: neither.
 */
export function speechHere(cohereKeys: readonly string[]): Ear | undefined {
  if (existsSync(WHISPER_MODEL)) return whisperSpeech();
  return cohereKeys.length ? cohereSpeech(cohereKeys) : undefined;
}
