/**
 * An extractor draws findings out of one document for one ask. The claim extractor is the one
 * in v1: the model proposes sentences with the exact words they rest on; the gate keeps a
 * finding only when its quote is on the document, word for word, and every number in it is in
 * the quote (a year may come from the document). What the model knows without the document
 * never becomes a finding.
 */
import { z } from "zod";
import { numbersQuoted, pageQuoted, words } from "../study/grounding.js";
import type { Model, Usage } from "./model.js";
import type { Document, Finding } from "./types.js";

/** What the run is after; the same fields raven's `Ask` has, met by structure. */
export interface AskView {
  text: string;
  /** Facts already in hand, one line each: the extractor looks past them. */
  known?: readonly string[];
}

export interface Dropped {
  text: string;
  why: string;
}

export interface Extracted {
  findings: Finding[];
  dropped: Dropped[];
  usage?: Usage;
}

export interface Extractor {
  name: string;
  extract(doc: Document, ask: AskView, model: Model): Promise<Extracted>;
}

const FINDINGS_PER_DOCUMENT = 12;
const FINDING_MAX_WORDS = 60;
const QUOTE_MIN_WORDS = 5;
/** The prompt asks for 60; a quote past this is a pasted section, not the words a finding rests on. */
const QUOTE_MAX_WORDS = 80;

export const CLAIM_PROMPT = `You pull facts out of one document for a research ask.

Return ONLY a JSON object, no prose, exactly this shape:
{"findings": [{"text": "...", "quote": "..."}]}

Rules:
- At most {max} findings, the most useful first. Only findings that serve the ask and are not known already.
- text: one plain sentence a person would say out loud, at most {words} words. Specific: a number, a named practice, a stated cause. State the fact itself, never "The document says" or "The page notes". Name the source only when it carries weight ("A 2025 survey of 400 firms found ...", "IANA says ...").
- quote: the exact words from the document that the finding rests on, copied character for character, 5 to 60 words.
- Every number in the text must appear in the quote.
- A company's marketing about itself is not a fact about the market.
- Nothing in the document serves the ask: return {"findings": []}.

Ask: {ask}
Known already (look past these):
{known}

DOCUMENT: {url}
{text}
`;

export const ClaimAnswer = z.object({
  findings: z.array(
    z.object({ text: z.string().nullable().optional(), quote: z.string().nullable().optional() }),
  ),
});
export type ClaimAnswer = z.infer<typeof ClaimAnswer>;

/** `{name}` marks filled in one pass: a "{word}" inside the document stays text. */
const fill = (template: string, values: Readonly<Record<string, string>>): string =>
  template.replace(/\{(\w+)\}/g, (mark, name: string) => values[name] ?? mark);

export function claimPrompt(doc: Document, ask: AskView): string {
  const known = ask.known ?? [];
  return fill(CLAIM_PROMPT, {
    max: String(FINDINGS_PER_DOCUMENT),
    words: String(FINDING_MAX_WORDS),
    ask: ask.text,
    known: known.length ? known.map((k) => `- ${k}`).join("\n") : "(nothing)",
    url: doc.url,
    text: doc.text,
  });
}

/** Every proposal through the gate: findings whose quote is on the document, dropped with why. */
export function gateFindings(answer: ClaimAnswer, doc: Document): Omit<Extracted, "usage"> {
  const page = { url: doc.url, text: doc.text };
  const findings: Finding[] = [];
  const dropped: Dropped[] = [];
  for (const p of answer.findings.slice(0, FINDINGS_PER_DOCUMENT)) {
    const text = (p.text ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const quote = (p.quote ?? "").trim();
    const why = !(words(text) <= FINDING_MAX_WORDS)
      ? "too_long"
      : words(quote) < QUOTE_MIN_WORDS
        ? "no_quote"
        : words(quote) > QUOTE_MAX_WORDS
          ? "quote_too_long"
          : !pageQuoted(quote, [page], doc.url)
            ? "quote_not_found"
            : !numbersQuoted(text, quote, page)
              ? "number_not_in_quote"
              : null;
    if (why) dropped.push({ text, why });
    else if (!findings.some((f) => f.proof.quote === quote))
      findings.push({ kind: "claim", text, proof: { url: doc.url, quote } });
  }
  return { findings, dropped };
}

/** The one extractor of v1: claims that quote the document. */
export const claimExtractor: Extractor = {
  name: "claim",
  async extract(doc, ask, model) {
    const { value, usage } = await model.ask(claimPrompt(doc, ask), ClaimAnswer);
    return { ...gateFindings(value, doc), ...(usage ? { usage } : {}) };
  },
};
