/**
 * The one shape every model call has. A prompt is a string or a list of parts; a reply is text,
 * tokens, USD and why it stopped. `ask` parses the reply to a zod shape. raven's and falcon's
 * `Model` (`id` plus `ask(prompt, shape)`) are met by structure: a `Model` from here is one.
 */
import type { ZodType } from "zod";

/** What a part holds: bytes (base64 or raw) or a URL the vendor fetches itself. */
export type Source = Uint8Array | string | URL;

export type Part =
  | { type: "text"; text: string }
  | { type: "image"; data: Source; mediaType: string }
  | { type: "video"; data: Source; mediaType: string }
  | { type: "audio"; data: Source; mediaType: string }
  | { type: "pdf"; data: Source };

export type PartKind = Part["type"];

/** How hard a model thinks. Anthropic and Gemini read it; others ignore it. */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface Request {
  prompt: string | readonly Part[];
  /** The standing instructions. On Anthropic it carries a cache breakpoint. */
  system?: string;
  /** A ceiling against a runaway answer, never the length: the prompt says how long. */
  maxTokens?: number;
  effort?: Effort;
  /** What the call is for (`triage`, `drafts`). No vendor sees it; meters group by it. */
  purpose?: string;
  signal?: AbortSignal;
}

export interface Usage {
  /** Every input token, cache reads and writes included. */
  input?: number;
  output?: number;
  /** Of `input`: read from the vendor's prompt cache. */
  cacheRead?: number;
  /** Of `input`: written to the cache (5 minutes unless `cacheWrite1h` says). */
  cacheWrite?: number;
  /** Of `cacheWrite`: the share that lives 1 hour. */
  cacheWrite1h?: number;
  /** What the call cost. 0 on a free key; absent only when the model has no price. */
  usd?: number;
  /** The call ran on a free tier: `usd` is 0 and `listUsd` is what it would cost. */
  free?: boolean;
  listUsd?: number;
}

export interface Reply {
  text: string;
  usage: Usage;
  /** The model that answered, as the vendor names it. */
  model: string;
  /** The vendor's own stop reason (`end_turn`, `max_tokens`, `STOP`, `length`). */
  stop: string | undefined;
  /** Wall-clock milliseconds for the round trip. */
  ms: number;
  /** The vendor's response metadata, kept for the caller to store. */
  raw: Record<string, unknown>;
}

/** A parsed answer and what it cost. */
export interface Answer<T> {
  value: T;
  usage?: Usage;
}

export interface AskOptions extends Omit<Request, "prompt"> {
  /** More calls after an answer that does not parse, each told why. Default 1. */
  repairs?: number;
}

export interface Model {
  /** The model id, as spends and records name it (`claude-haiku-5-5`, `groq:openai/gpt-oss-120b`). */
  readonly id: string;
  /** The vendor alone (`anthropic`, `groq`), for per-vendor sums. */
  readonly provider: string;
  /** The part kinds it takes. A part outside this set throws `Unsupported`, never dropped. */
  readonly takes: ReadonlySet<PartKind>;
  complete(request: Request | string): Promise<Reply>;
  ask<T>(prompt: string | readonly Part[], shape: ZodType<T>, o?: AskOptions): Promise<Answer<T>>;
}
