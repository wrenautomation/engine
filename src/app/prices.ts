/**
 * What a model call costs, in USD, from the tokens it reports. Anthropic's list prices per
 * million tokens, by model id; Claude Haiku 5.5 has two rate cards, by prompt length. A model
 * not in the table gets no `usd`: the spend row keeps the model id and the tokens, so the
 * price can be applied later. Prices as of 2026-10: check `https://claude.com/pricing`.
 */
import type { Usage } from "@wrenautomation/raven";

interface Rate {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
  /** A second rate card for a prompt over this many tokens. */
  over?: { tokens: number; input: number; output: number };
}

export const ANTHROPIC_PRICES: Readonly<Record<string, Rate>> = {
  "claude-haiku-5-5": {
    input: 0.1,
    output: 0.5,
    over: { tokens: 100_000, input: 0.5, output: 2.5 },
  },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-opus-5-5": { input: 4, output: 20 },
};

/** The call's cost in USD, or undefined when the model has no price here. */
export function priceUsd(
  model: string,
  usage: { input?: number; output?: number },
): number | undefined {
  const rate = ANTHROPIC_PRICES[model];
  if (!rate) return undefined;
  const input = usage.input ?? 0;
  const output = usage.output ?? 0;
  const card = rate.over && input > rate.over.tokens ? rate.over : rate;
  return (input * card.input + output * card.output) / 1_000_000;
}

/** The usage with its price, when the model has one. */
export function priced(model: string, usage: { input: number; output: number }): Usage {
  const usd = priceUsd(model, usage);
  return { ...usage, ...(usd !== undefined ? { usd } : {}) };
}
