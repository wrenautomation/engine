/**
 * Claude direct as raven's `Model`: one user turn on `messages.create`, the answer parsed with
 * raven's shape, the usage the API reports. The SDK's own retries are off: the runner owns
 * retries, so a 429, a 529, a 5xx or a dropped connection comes out as `Transient` with the
 * `retry-after` the API sent. `haiku`, `sonnet` and `opus` name the current Claude 5.5 ids.
 * The output cap is 8192 tokens: an extract of a long document with its quotes passed 4096.
 * An answer the cap cut is falcon's `Cut`, the text so far and the usage with it: the claim
 * extractor keeps the whole findings and asks again for the rest of the document. The usage
 * carries `usd` from the price table in `prices.ts`.
 */
import Anthropic from "@anthropic-ai/sdk";
import { Cut } from "@wrenautomation/falcon/document";
import { type Model, parseAnswer } from "@wrenautomation/raven";
import { Transient } from "../engine/transient.js";
import { priced } from "./prices.js";

export const ANTHROPIC_ALIASES: Readonly<Record<string, string>> = {
  haiku: "claude-haiku-5-5",
  sonnet: "claude-sonnet-5-5",
  opus: "claude-opus-5-5",
};

/** `haiku` (the default), `sonnet`, `opus`, or a model id as is. */
export const anthropicId = (spec = "haiku"): string => ANTHROPIC_ALIASES[spec] ?? spec;

export const MAX_TOKENS = 8192;

export function anthropicModel(o: {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  fetchFn?: typeof fetch;
}): Model {
  const model = anthropicId(o.model);
  const client = new Anthropic({
    apiKey: o.apiKey,
    maxRetries: 0,
    ...(o.fetchFn ? { fetch: o.fetchFn } : {}),
  });
  return {
    id: model,
    async ask(prompt, shape) {
      let res: Anthropic.Message;
      try {
        res = await client.messages.create({
          model,
          max_tokens: o.maxTokens ?? MAX_TOKENS,
          messages: [{ role: "user", content: prompt }],
        });
      } catch (err) {
        throw failure(model, err);
      }
      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      if (!text) throw new Error(`anthropic ${model}: empty answer (${res.stop_reason})`);
      if (res.stop_reason === "max_tokens")
        throw new Cut(
          `anthropic ${model}: the answer was cut at ${res.usage.output_tokens} output tokens (max_tokens ${o.maxTokens ?? MAX_TOKENS})`,
          text,
          priced(model, { input: res.usage.input_tokens, output: res.usage.output_tokens }),
        );
      return {
        value: parseAnswer(text, shape),
        usage: priced(model, { input: res.usage.input_tokens, output: res.usage.output_tokens }),
      };
    },
  };
}

/** The SDK's error as the engine's: Transient when another try may answer. */
function failure(model: string, err: unknown): Error {
  if (!(err instanceof Anthropic.APIError))
    return err instanceof Error ? err : new Error(String(err));
  const status = err.status;
  const message = `anthropic ${model}: ${status === undefined ? "no answer" : `HTTP ${status}`} ${err.message}`;
  return status === undefined || status === 429 || status >= 500
    ? new Transient(message, { retryAfter: err.headers?.get("retry-after") })
    : new Error(message);
}
