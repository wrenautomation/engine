/**
 * The sample check: does a finding's quote back what its sentence says? The extract gate already
 * proves the quote is on the document word for word and holds the sentence's numbers; it cannot
 * see a sentence that says more than its quote, or a quote torn from a context that turns it.
 * A model reads the quote in its context and says yes or no, with why. A run checks a sample
 * and every finding a pattern rests on: the share that fails is the read on the whole extract.
 * A no comes with a fix when one fits: a narrower sentence the quote does back. The caller puts
 * it through the gate and a second check before it keeps it.
 *
 * The model sees the text around the quote, not the whole document: `WINDOW` characters each
 * side. A finding with no quote (a timestamp or a frame) is not checked here.
 */
import { z } from "zod";
import { fill } from "../study/claims.js";
import type { Model, Usage } from "./model.js";
import type { Document, Finding } from "./types.js";

/** Characters of context each side of the quote. */
export const WINDOW = 3000;

export const CHECK_PROMPT = `You check one fact drawn from a document: does the quote back what the sentence says?

Return ONLY a JSON object, no prose, exactly this shape:
{"ok": true, "why": "...", "fix": ""}

Rules:
- "ok": true when the quote, read in its context, says what the sentence says. A plain rewording is fine.
- "ok": false when the sentence says more than the quote (a number, a cause, a scope, a certainty it lacks), or when the context turns the quote (a question, a hypothetical, someone the author argues against, an ad).
- "why": one short sentence a person reads to agree or not.
- "fix": when "ok" is false, one narrower sentence the quote does back in its context, in the same style: who says it, its hedge, its scope. An empty string when "ok" is true or no sentence would serve.

Sentence: {text}
Quote: {quote}

CONTEXT from {url}:
{context}
`;

export const CheckAnswer = z.object({
  ok: z.boolean(),
  why: z.string(),
  fix: z.string().nullable().optional(),
});

export interface Checked {
  ok: boolean;
  why: string;
  /** On a no: a narrower sentence the quote backs, unchecked. */
  fix?: string;
  usage?: Usage;
}

/** The quote's context: `WINDOW` characters each side, or the start of the text when the quote is not found. */
export function contextOf(text: string, quote: string): string {
  const at = text.indexOf(quote);
  const from = Math.max(0, (at < 0 ? 0 : at) - WINDOW);
  const to = Math.min(text.length, (at < 0 ? 0 : at + quote.length) + WINDOW);
  return `${from > 0 ? "…" : ""}${text.slice(from, to)}${to < text.length ? "…" : ""}`;
}

export function checkPrompt(finding: Finding, doc: Document): string {
  const quote = finding.proof.quote ?? "";
  return fill(CHECK_PROMPT, {
    text: finding.text,
    quote,
    url: doc.url,
    context: contextOf(doc.text, quote),
  });
}

/** The model's word on one finding, or null when the finding has no quote to check. */
export async function checkFinding(
  finding: Finding,
  doc: Document,
  model: Model,
): Promise<Checked | null> {
  if (!finding.proof.quote) return null;
  const { value, usage } = await model.ask(checkPrompt(finding, doc), CheckAnswer);
  const fix = value.ok ? "" : (value.fix ?? "").replace(/\s+/g, " ").trim();
  return {
    ok: value.ok,
    why: value.why.replace(/\s+/g, " ").trim(),
    ...(fix && fix !== finding.text ? { fix } : {}),
    ...(usage ? { usage } : {}),
  };
}
