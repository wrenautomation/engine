/**
 * Speech to text: the `Ear` door. Every vendor here takes the OpenAI-style multipart POST to
 * `/audio/transcriptions` (Groq, Cohere, a self-hosted whisper server). No `node:` import: the
 * portal Worker uses it.
 */
import { httpError, transport } from "./errors.js";
import { cursor, overRing, type RotateOptions } from "./keys.js";
import { speechUsd } from "./prices.js";

export interface Audio {
  data: Uint8Array;
  /** `audio/wav`, `audio/mpeg`. */
  mediaType: string;
  filename?: string;
}

export interface HearOptions {
  /** ISO 639-1. Default `en`. */
  language?: string;
  /** The audio's length, when known: it prices the call. */
  seconds?: number;
  signal?: AbortSignal;
}

export interface Heard {
  text: string;
  /** The model that heard it. */
  model: string;
  ms: number;
  /** 0 on a free key; absent when the model or the length has no price. */
  usd?: number;
  free?: boolean;
  listUsd?: number;
}

export interface Ear {
  /** As spends name it (`groq:whisper-large-v3-turbo`). */
  readonly id: string;
  readonly model: string;
  hear(audio: Audio, o?: HearOptions): Promise<Heard>;
}

const EXT: Record<string, string> = {
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
};

export interface EarOptions {
  /** The full `/audio/transcriptions` URL. */
  url: string;
  model: string;
  /** None for a server with no auth. */
  key?: string | readonly string[];
  /** The vendor, for the id. Default: the URL's host. */
  vendor?: string;
  free?: boolean;
  /** Send `response_format=json` (OpenAI's field). Default true; Cohere's route takes no such field. */
  jsonFormat?: boolean;
  /** Bytes the vendor takes at most; a larger file throws before the call. */
  maxBytes?: number;
  limitMs?: number;
  rotate?: RotateOptions;
  fetch?: typeof fetch;
}

/** Any OpenAI-compatible transcription endpoint. Keys travel in a header, never in an error. */
export function compatibleEar(o: EarOptions): Ear {
  const vendor = o.vendor ?? new URL(o.url).hostname;
  const id = `${vendor}:${o.model}`;
  const keys: readonly (string | undefined)[] =
    o.key === undefined ? [undefined] : typeof o.key === "string" ? [o.key] : o.key;
  if (!keys.length) throw new Error(`${id} needs at least one key`);
  const go = o.fetch ?? fetch;
  const next = cursor();
  return {
    id,
    model: o.model,
    async hear(audio, h = {}) {
      if (o.maxBytes && audio.data.byteLength > o.maxBytes)
        throw new Error(
          `${id}: ${(audio.data.byteLength / 1e6).toFixed(1)} MB of audio, over its ${o.maxBytes / 1e6} MB`,
        );
      const started = performance.now();
      const once = async (key: string | undefined) => {
        const form = new FormData();
        const name = audio.filename ?? `audio.${EXT[audio.mediaType] ?? "bin"}`;
        form.set(
          "file",
          new Blob([audio.data as Uint8Array<ArrayBuffer>], { type: audio.mediaType }),
          name,
        );
        form.set("model", o.model);
        if (o.jsonFormat !== false) form.set("response_format", "json");
        form.set("language", h.language ?? "en");
        const timeout = AbortSignal.timeout(o.limitMs ?? 120_000);
        let res: Response;
        try {
          res = await go(o.url, {
            method: "POST",
            headers: key ? { authorization: `Bearer ${key}` } : {},
            body: form,
            signal: h.signal ? AbortSignal.any([h.signal, timeout]) : timeout,
          });
        } catch (err) {
          if (h.signal?.aborted) throw err;
          throw transport(id, err);
        }
        if (!res.ok) throw httpError(id, res, (await res.text().catch(() => "")).slice(0, 200));
        const body = (await res.json().catch(() => ({}))) as { text?: unknown };
        return typeof body.text === "string" ? body.text.trim() : "";
      };
      const text = await overRing(keys, once, next, o.rotate);
      const list = h.seconds === undefined ? undefined : speechUsd(o.model, h.seconds);
      const cost: Partial<Heard> = o.free
        ? { usd: 0, free: true, ...(list !== undefined ? { listUsd: list } : {}) }
        : list !== undefined
          ? { usd: list }
          : {};
      return { text, model: o.model, ms: Math.round(performance.now() - started), ...cost };
    },
  };
}

export const COHERE_SPEECH_MODEL = "cohere-transcribe-03-2026";

/** Cohere's transcription on the free key ring. It takes 25 MB at most. */
export const cohereEar = (o: {
  key: string | readonly string[];
  rotate?: RotateOptions;
  fetch?: typeof fetch;
}) =>
  compatibleEar({
    url: "https://api.cohere.com/v2/audio/transcriptions",
    model: COHERE_SPEECH_MODEL,
    vendor: "cohere",
    free: true,
    jsonFormat: false,
    maxBytes: 25_000_000,
    ...o,
  });

/** Whisper on Groq's free key ring. */
export const groqEar = (o: {
  key: string | readonly string[];
  model?: string;
  rotate?: RotateOptions;
  fetch?: typeof fetch;
}) =>
  compatibleEar({
    url: "https://api.groq.com/openai/v1/audio/transcriptions",
    model: o.model ?? "whisper-large-v3-turbo",
    vendor: "groq",
    free: true,
    maxBytes: 25_000_000,
    key: o.key,
    ...(o.rotate ? { rotate: o.rotate } : {}),
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });

/** An ear for tests and dry runs: no network, no keys. Answers each call from `respond`. */
export function fakeEar(
  respond: string | ((audio: Audio, o: HearOptions) => string | Promise<string>) = "",
  id = "fake:ear",
): Ear {
  return {
    id,
    model: id,
    async hear(audio, o = {}) {
      const text = typeof respond === "string" ? respond : await respond(audio, o);
      return { text, model: id, ms: 0, usd: 0 };
    },
  };
}
