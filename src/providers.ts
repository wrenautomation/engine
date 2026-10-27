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
import type { Model, PartKind } from "./types.js";

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
  /** For tests: the wire. */
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
        modelId,
        model: createAnthropic({ apiKey, ...wire(o) })(modelId),
        takes: kinds("text", "image", "pdf"),
        ...(o.limitMs ? { limitMs: o.limitMs } : {}),
      }),
    o.rotate,
    "anthropic",
  );
}

/** Gemini on the free key ring. It takes every part kind, YouTube URLs as video included. */
export function gemini(o: VendorOptions): Model {
  const modelId = o.model ?? "gemini-3.5-flash";
  return ring(
    keyList(o.key),
    (apiKey) =>
      sdkModel({
        provider: "google",
        modelId,
        model: createGoogle({ apiKey, ...wire(o) })(modelId),
        takes: kinds("text", "image", "video", "audio", "pdf"),
        free: true,
        ...(o.limitMs ? { limitMs: o.limitMs } : {}),
      }),
    o.rotate,
    "gemini",
  );
}

/** Cohere's own API on the free key ring: text and images. */
export function cohere(o: VendorOptions): Model {
  const modelId = o.model ?? "command-a-03-2025";
  return ring(
    keyList(o.key),
    (apiKey) =>
      sdkModel({
        provider: "cohere",
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
