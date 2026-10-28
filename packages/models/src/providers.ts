/**
 * The vendors. Each maker returns a `Model`; a list of keys returns one rotating over them.
 * Free key rings (Cohere, Gemini, Groq, OpenRouter's `:free` models, the gateway's `free` alias)
 * cost 0 and keep their list price; the rest are priced from the table.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createCohere } from "@ai-sdk/cohere";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { type RotateOptions, rotating } from "./keys.js";
import { TEXT_ONLY } from "./model.js";
import { sdkModel } from "./sdk.js";
import type { Clip, Model, Part, PartKind } from "./types.js";

const kinds = (...k: PartKind[]): ReadonlySet<PartKind> => new Set(k);
const keyList = (key: string | readonly string[]) => (typeof key === "string" ? [key] : key);

const ring = (
  keys: readonly string[],
  make: (key: string) => Model,
  o: RotateOptions | undefined,
  vendor: string,
): Model => {
  if (!keys.length) throw new Error(`${vendor} needs at least one key`);
  return rotating(keys.map(make), o);
};

/** Short names for the current Claude models. A full id passes through. */
export const ANTHROPIC_MODELS: Readonly<Record<string, string>> = {
  haiku: "claude-haiku-5-5",
  sonnet: "claude-sonnet-5-5",
  opus: "claude-opus-5-5",
};
export const anthropicModelId = (name: string): string => ANTHROPIC_MODELS[name] ?? name;

export interface VendorOptions {
  key: string | readonly string[];
  /** A model id or, on Anthropic, a short name. */
  model?: string;
  rotate?: RotateOptions;
  limitMs?: number;
  /** The wire: a test's, or a proxy's (wren's gateway holds Gemini keys behind one). */
  fetch?: typeof fetch;
}

const wire = (o: { fetch?: typeof fetch }) => (o.fetch ? { fetch: o.fetch } : {});

/** Claude on Wren's own key. Default Haiku 5.5. */
export function anthropic(o: VendorOptions): Model {
  const modelId = anthropicModelId(o.model ?? "haiku");
  return ring(
    keyList(o.key),
    (apiKey) =>
      sdkModel({
        provider: "anthropic",
        secret: apiKey,
        modelId,
        model: createAnthropic({ apiKey, ...wire(o) })(modelId),
        takes: kinds("text", "image", "pdf"),
        ...(o.limitMs ? { limitMs: o.limitMs } : {}),
      }),
    o.rotate,
    "anthropic",
  );
}

/**
 * Gemini on the free key ring. It takes every part kind, YouTube URLs as video included. A video
 * part with a `clip` goes to generateContent with `videoMetadata` (`withClips`). Gemini's
 * Interactions API also reads a stretch, but on free keys its flash quota is spent at once.
 */
export function gemini(o: VendorOptions): Model {
  const modelId = o.model ?? "gemini-3.5-flash";
  return ring(
    keyList(o.key),
    (apiKey) =>
      sdkModel({
        provider: "google",
        secret: apiKey,
        modelId,
        model: createGoogle({ apiKey, ...wire(o) })(modelId),
        clipModel: (clips) =>
          createGoogle({ apiKey, fetch: withClips(clips, o.fetch ?? fetch) })(modelId),
        takes: kinds("text", "image", "video", "audio", "pdf"),
        free: true,
        ...(o.limitMs ? { limitMs: o.limitMs } : {}),
      }),
    o.rotate,
    "gemini",
  );
}

/**
 * A fetch that adds Gemini's `videoMetadata` to each video part of a generateContent body: one
 * clip per video part, in prompt order (`undefined` leaves that part whole). The SDK builds the
 * rest of the body and reads the reply.
 */
export function withClips(clips: readonly (Clip | undefined)[], go: typeof fetch): typeof fetch {
  return (url, init) => {
    if (typeof init?.body !== "string") return go(url, init);
    const body = JSON.parse(init.body) as { contents?: { parts?: Record<string, unknown>[] }[] };
    let n = 0;
    for (const content of body.contents ?? [])
      for (const part of content.parts ?? []) {
        const file = (part.fileData ?? part.inlineData) as { mimeType?: string } | undefined;
        if (!file?.mimeType?.startsWith("video/")) continue;
        const clip = clips[n++];
        if (clip)
          part.videoMetadata = {
            startOffset: `${clip.startS}s`,
            endOffset: `${clip.endS}s`,
            ...(clip.fps ? { fps: clip.fps } : {}),
          };
      }
    return go(url, { ...init, body: JSON.stringify(body) });
  };
}

/** A file in Gemini's Files API: read it with a Gemini model on `key` alone. */
export interface GeminiFile {
  /** The file lives in this key's project; another key cannot read it. */
  key: string;
  /** `files/<id>`. */
  name: string;
  part: Part;
  /** Deletes it now. The API also deletes it after 48 hours. */
  drop(): Promise<void>;
}

const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta";

function filePart(uri: string, mediaType: string): Part {
  const data = new URL(uri);
  if (mediaType === "application/pdf") return { type: "pdf", data };
  const kind = mediaType.split("/")[0];
  if (kind === "video" || kind === "audio" || kind === "image")
    return { type: kind, data, mediaType };
  throw new Error(`gemini file: no part kind for ${mediaType}`);
}

/**
 * Uploads bytes too large to send inline (a long video) to Gemini's Files API, through the SDK's
 * uploader, and waits until the file can be read. It tries each key in turn: a key that refuses
 * passes to the next.
 */
export async function geminiFile(
  data: Uint8Array,
  o: {
    key: string | readonly string[];
    mediaType: string;
    displayName?: string;
    pollMs?: number;
    fetch?: typeof fetch;
  },
): Promise<GeminiFile> {
  const keys = keyList(o.key);
  if (!keys.length) throw new Error("gemini file needs at least one key");
  let last = "";
  for (const key of keys) {
    try {
      const up = await createGoogle({ apiKey: key, ...wire(o) })
        .files()
        .uploadFile({
          data: { type: "data", data },
          mediaType: o.mediaType,
          providerOptions: {
            google: {
              ...(o.displayName ? { displayName: o.displayName } : {}),
              ...(o.pollMs ? { pollIntervalMs: o.pollMs } : {}),
            },
          },
        });
      const uri = up.providerReference.google;
      const name = String(up.providerMetadata?.google?.name ?? "");
      if (!uri || !name) throw new Error("no file uri in the reply");
      const go = o.fetch ?? fetch;
      return {
        key,
        name,
        part: filePart(uri, o.mediaType),
        drop: async () => {
          await go(`${GEMINI_API}/${name}`, {
            method: "DELETE",
            headers: { "x-goog-api-key": key },
          }).catch(() => {});
        },
      };
    } catch (err) {
      last = (err instanceof Error ? err.message : String(err))
        .replaceAll(key, "<key>")
        .slice(0, 200);
    }
  }
  throw new Error(`gemini file: every key refused, last ${last}`);
}

const GEMINI_MODELS = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1";

/**
 * The Gemini keys the API still takes. A suspended key answers 403 and the ring passes it at once,
 * but only after the call is sent: check first before a large inline body goes to each.
 */
export async function geminiLiveKeys(
  keys: readonly string[],
  o: { fetch?: typeof fetch } = {},
): Promise<string[]> {
  const fetchFn = o.fetch ?? fetch;
  const ok = await Promise.all(
    keys.map((key) =>
      fetchFn(GEMINI_MODELS, {
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

/** Cohere's own API on the free key ring: text and images. */
export function cohere(o: VendorOptions): Model {
  const modelId = o.model ?? "command-a-03-2025";
  return ring(
    keyList(o.key),
    (apiKey) =>
      sdkModel({
        provider: "cohere",
        secret: apiKey,
        modelId,
        model: createCohere({ apiKey, ...wire(o) })(modelId),
        takes: modelId.includes("vision") ? kinds("text", "image") : TEXT_ONLY,
        free: true,
        ...(o.limitMs ? { limitMs: o.limitMs } : {}),
      }),
    o.rotate,
    "cohere",
  );
}

/** OpenAI-compatible vendors: base URL, default model, and whether Wren's keys there are free. */
export const COMPATIBLE = {
  groq: {
    baseURL: "https://api.groq.com/openai/v1",
    model: "openai/gpt-oss-120b",
    free: () => true,
  },
  openrouter: {
    baseURL: "https://openrouter.ai/api/v1",
    model: "google/gemma-4-31b-it:free",
    free: (m: string) => m.endsWith(":free"),
  },
  mistral: {
    baseURL: "https://api.mistral.ai/v1",
    model: "mistral-small-latest",
    free: () => false,
  },
  cerebras: { baseURL: "https://api.cerebras.ai/v1", model: "gpt-oss-120b", free: () => false },
  openai: { baseURL: "https://api.openai.com/v1", model: "gpt-5-mini", free: () => false },
} as const;
export type CompatibleVendor = keyof typeof COMPATIBLE;

export const isCompatible = (v: string): v is CompatibleVendor => Object.hasOwn(COMPATIBLE, v);

export function compatible(vendor: CompatibleVendor, o: VendorOptions): Model {
  const spec = COMPATIBLE[vendor];
  const modelId = o.model ?? spec.model;
  return ring(
    keyList(o.key),
    (apiKey) =>
      sdkModel({
        provider: vendor,
        secret: apiKey,
        modelId,
        model: createOpenAICompatible({ name: vendor, baseURL: spec.baseURL, apiKey, ...wire(o) })(
          modelId,
        ),
        takes: TEXT_ONLY,
        free: spec.free(modelId),
        ...(o.limitMs ? { limitMs: o.limitMs } : {}),
      }),
    o.rotate,
    vendor,
  );
}

/** The gateway's Gemini spends output tokens thinking first: 400 asked came back as 27 chars. */
export const GATEWAY_THINKING = 4096;

/** `<url>/v1`; a URL given with its `/v1` is not doubled. */
export const gatewayBase = (url: string) => `${url.replace(/\/$/, "").replace(/\/v1$/, "")}/v1`;

/**
 * Wren's LLM gateway (llm.wrenautomation.com): it holds the free keys and one ledger. Its model is
 * an alias (`free`, `cohere`) or `<vendor>/<model>`. `free` costs 0.
 */
export function gateway(o: {
  url: string;
  token: string;
  model?: string;
  limitMs?: number;
  fetch?: typeof fetch;
}): Model {
  const modelId = o.model ?? "free";
  return sdkModel({
    provider: "gateway",
    modelId,
    model: createOpenAICompatible({
      name: "gateway",
      baseURL: gatewayBase(o.url),
      apiKey: o.token,
      ...wire(o),
    })(modelId),
    takes: TEXT_ONLY,
    thinking: GATEWAY_THINKING,
    free: modelId === "free",
    priceId: modelId.slice(modelId.indexOf("/") + 1),
    ...(o.limitMs ? { limitMs: o.limitMs } : {}),
  });
}
