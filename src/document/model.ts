/**
 * The model seam an extractor uses: a prompt and an answer shape in, the parsed answer and what
 * it cost out. The same shape as raven's `Model`, met by structure: falcon depends on nothing of
 * ours.
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
