/**
 * One AI SDK language model as a `Model`. The SDK speaks each vendor's wire; this maps our
 * request in and the reply, tokens, price and errors out. The SDK's own retries are off: the
 * caller (a runner, a key ring) owns trying again.
 */
import {
  APICallError,
  generateText,
  type LanguageModel,
  type ModelMessage,
  type SystemModelMessage,
} from "ai";
import { Cut, Filtered, redact, statusError, Transient, transport } from "./errors.js";
import { modelOf } from "./model.js";
import { wellFormed } from "./parse.js";
import { priced } from "./prices.js";
import type { Clip, Effort, Model, Part, PartKind, Request, Usage } from "./types.js";

/** The ceiling when a request names none. A long extract with quotes passed 4096 on a live run. */
export const DEFAULT_MAX_TOKENS = 8192;
/** The least a call may answer in: a lower cap only cuts an answer off. */
const FLOOR_TOKENS = 2048;
/** One call, wall clock: a long draft takes a minute or two. */
export const CALL_LIMIT_MS = 5 * 60_000;

export interface SdkModelOptions {
  /** The vendor (`anthropic`, `groq`, `gateway`). */
  provider: string;
  /** The vendor's model id. */
  modelId: string;
  model: LanguageModel;
  /**
   * The model for a request with a clipped video, given each video part's clip in prompt order.
   * Gemini's: generateContent with `videoMetadata`, a field the SDK does not send (`withClips`).
   */
  clipModel?: (clips: readonly (Clip | undefined)[]) => LanguageModel;
  takes: ReadonlySet<PartKind>;
  /** Tokens added to every ceiling for a model that thinks inside its output budget. */
  thinking?: number;
  /** A free key: the reply costs 0 and keeps its list price. */
  free?: boolean;
  /** The id the price table knows, when it is not `modelId`. */
  priceId?: string;
  limitMs?: number;
  /** The call's key, put out of every error message. */
  secret?: string;
}

const GEMINI_LEVEL: Record<Effort, "low" | "medium" | "high"> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  max: "high",
};

const GEMINI_RESOLUTION = {
  low: "MEDIA_RESOLUTION_LOW",
  medium: "MEDIA_RESOLUTION_MEDIUM",
  high: "MEDIA_RESOLUTION_HIGH",
} as const;

/** Effort and resolution as the vendor's options. */
function vendorOptions(provider: string, req: Request) {
  if (provider === "anthropic")
    return req.effort ? { providerOptions: { anthropic: { effort: req.effort } } } : {};
  if (provider !== "google") return {};
  const level = req.effort ? GEMINI_LEVEL[req.effort] : undefined;
  const google = {
    ...(level ? { thinkingConfig: { thinkingLevel: level } } : {}),
    ...(req.resolution ? { mediaResolution: GEMINI_RESOLUTION[req.resolution] } : {}),
  };
  return Object.keys(google).length ? { providerOptions: { google } } : {};
}

/** Each video part's clip, in prompt order; null when no part has one. */
function clipsOf(req: Request): (Clip | undefined)[] | null {
  if (typeof req.prompt === "string") return null;
  const clips = req.prompt.flatMap((p) => (p.type === "video" ? [p.clip] : []));
  return clips.some(Boolean) ? clips : null;
}

function contentOf(parts: readonly Part[]) {
  return parts.map((p) => {
    switch (p.type) {
      case "text":
        return { type: "text" as const, text: wellFormed(p.text) };
      case "image":
        return { type: "file" as const, data: p.data, mediaType: p.mediaType };
      case "pdf":
        return { type: "file" as const, data: p.data, mediaType: "application/pdf" };
      default:
        return { type: "file" as const, data: p.data, mediaType: p.mediaType };
    }
  });
}

/** System and prompt in the SDK's shape. On Anthropic the system carries a cache breakpoint. */
function input(
  provider: string,
  req: Request,
): { system?: string | SystemModelMessage } & ({ prompt: string } | { messages: ModelMessage[] }) {
  const body =
    typeof req.prompt === "string"
      ? { prompt: wellFormed(req.prompt) }
      : { messages: [{ role: "user" as const, content: contentOf(req.prompt) }] };
  if (!req.system) return body;
  if (provider !== "anthropic") return { system: wellFormed(req.system), ...body };
  return {
    system: {
      role: "system",
      content: wellFormed(req.system),
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    },
    ...body,
  };
}

function failure(
  what: string,
  err: unknown,
  signal: AbortSignal | undefined,
  secrets: readonly string[],
): unknown {
  if (signal?.aborted) return err;
  if (APICallError.isInstance(err)) {
    if (err.statusCode === undefined) return transport(what, err);
    const detail = redact(err.message, secrets).slice(0, 300);
    return statusError(
      `${what}: HTTP ${err.statusCode} ${detail}`,
      err.statusCode,
      err.responseHeaders?.["retry-after"],
    );
  }
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError"))
    return new Transient(`${what}: no answer in time`, { cause: err });
  if (err instanceof TypeError) return transport(what, err);
  return err;
}

export function sdkModel(o: SdkModelOptions): Model {
  const id = o.provider === "anthropic" ? o.modelId : `${o.provider}:${o.modelId}`;
  const limitMs = o.limitMs ?? CALL_LIMIT_MS;
  return modelOf({
    id,
    provider: o.provider,
    takes: o.takes,
    async complete(req) {
      const started = performance.now();
      const timeout = AbortSignal.timeout(limitMs);
      const abortSignal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
      const clips = o.clipModel ? clipsOf(req) : null;
      let result: Awaited<ReturnType<typeof generateText>>;
      try {
        result = await generateText({
          model: clips && o.clipModel ? o.clipModel(clips) : o.model,
          ...input(o.provider, req),
          maxOutputTokens:
            Math.max(req.maxTokens ?? DEFAULT_MAX_TOKENS, FLOOR_TOKENS) + (o.thinking ?? 0),
          ...vendorOptions(o.provider, req),
          maxRetries: 0,
          abortSignal,
        });
      } catch (err) {
        throw failure(id, err, req.signal, o.secret ? [o.secret] : []);
      }
      const u = result.usage;
      const tokens: Usage = {};
      if (u.inputTokens !== undefined) tokens.input = u.inputTokens;
      if (u.outputTokens !== undefined) tokens.output = u.outputTokens;
      if (u.inputTokenDetails?.cacheReadTokens)
        tokens.cacheRead = u.inputTokenDetails.cacheReadTokens;
      if (u.inputTokenDetails?.cacheWriteTokens)
        tokens.cacheWrite = u.inputTokenDetails.cacheWriteTokens;
      const usage = priced(o.priceId ?? o.modelId, tokens, { free: o.free ?? false });
      const stop = result.rawFinishReason ?? result.finishReason;
      if (result.finishReason === "length")
        throw new Cut(`${id} stopped at its output cap (${stop})`, result.text, usage);
      if (result.finishReason === "content-filter")
        throw new Filtered(
          `${id} stopped the answer itself (${stop})`,
          String(stop),
          result.text,
          usage,
        );
      if (!result.text) throw new Error(`${id}: no text in the reply (stop ${stop})`);
      return {
        text: result.text,
        usage,
        model: result.response.modelId || o.modelId,
        stop,
        ms: Math.round(performance.now() - started),
        raw: {
          provider: o.provider,
          model: o.modelId,
          stop_reason: stop,
          finish_reason_unified: result.finishReason,
          usage: {
            input_tokens: u.inputTokens ?? null,
            output_tokens: u.outputTokens ?? null,
            reasoning_tokens: u.outputTokenDetails?.reasoningTokens ?? null,
            cache_read_tokens: u.inputTokenDetails?.cacheReadTokens ?? null,
            cache_write_tokens: u.inputTokenDetails?.cacheWriteTokens ?? null,
          },
          response: {
            id: result.response.id,
            model_id: result.response.modelId,
            timestamp: result.response.timestamp.toISOString(),
          },
          provider_metadata: result.providerMetadata ?? null,
          warnings: result.warnings ?? [],
        },
      };
    },
  });
}
