/**
 * The model seam an extractor uses: a prompt and an answer shape in, the parsed answer and what
 * it cost out. The same shape as raven's `Model`, met by structure: falcon depends on nothing of
 * ours. A model whose output cap cut the answer throws a `Cut` with the text so far: the claim
 * extractor keeps what is whole and asks again for the rest of the document.
 */
import type { ZodType } from "zod";

/** What one model call cost, as far as the model says. */
export interface Usage {
  /** Tokens in and out. */
  input?: number;
  output?: number;
  usd?: number;
}

export interface Answer<T> {
  value: T;
  usage?: Usage;
}

export interface Model {
  /** What goes in `by` on the records this model writes. */
  id: string;
  ask<T>(prompt: string, shape: ZodType<T>): Promise<Answer<T>>;
}

/** The output cap cut the answer: `partial` is the text the model got out before it. */
export class Cut extends Error {
  readonly partial: string;
  readonly usage: Usage | undefined;
  constructor(message: string, partial: string, usage?: Usage) {
    super(message);
    this.name = "Cut";
    this.partial = partial;
    this.usage = usage;
  }
}

/** A `Cut` by shape, not by class: a host may hold a second copy of falcon. */
export const isCut = (err: unknown): err is Cut =>
  err instanceof Error && err.name === "Cut" && typeof (err as Cut).partial === "string";

/** Two usages added, each field summed where either side has it. */
export function addUsage(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
  if (!a) return b;
  if (!b) return a;
  const sum = (x?: number, y?: number) =>
    x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0);
  const out: Usage = {};
  const input = sum(a.input, b.input);
  const output = sum(a.output, b.output);
  const usd = sum(a.usd, b.usd);
  if (input !== undefined) out.input = input;
  if (output !== undefined) out.output = output;
  if (usd !== undefined) out.usd = usd;
  return out;
}
