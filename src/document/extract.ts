/**
 * An extractor draws findings out of one document for one ask, and says what the document was
 * worth. The claim extractor is the one in v1: the model proposes sentences with the exact words
 * they rest on; the gate keeps a finding only when its quote is on the document, word for word,
 * and every number in it is in the quote (a year may come from the document). What the model
 * knows without the document never becomes a finding. The verdict is the same call's word on the
 * document (`quality`) and on the ask (`gap`); the gate corrects a `rich` that kept nothing.
 */
import { z } from "zod";
import { fill } from "../study/claims.js";
import { numbersQuoted, pageQuoted, words } from "../study/grounding.js";
import type { Model, Usage } from "./model.js";
import { type Document, type Finding, Quality, type Verdict } from "./types.js";

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
  /** The document's worth and what the ask still lacks. */
  verdict: Verdict;
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
{"findings": [{"text": "...", "quote": "..."}], "quality": "rich", "gap": "..."}

Rules:
- At most {max} findings, the most useful first. Only findings that serve the ask and are not known already.
- text: one plain sentence a person would say out loud, at most {words} words. Specific: a number, a named practice, a stated cause. State the fact itself, never "The document says" or "The page notes". Name the source only when it carries weight ("A 2025 survey of 400 firms found ...", "IANA says ...").
- quote: the exact words from the document that the finding rests on, copied character for character, 5 to 60 words.
- Every number in the text must appear in the quote.
- A company's marketing about itself is not a fact about the market.
- Nothing in the document serves the ask: return {"findings": [], "quality": "off", "gap": "..."}.
- quality: "rich" when the document answers much of the ask, "thin" when it serves it a little, "off" when it is about something else.
- gap: one short sentence on what the ask still lacks after this document, or an empty string when nothing is missing.

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
  quality: Quality.nullable().optional(),
  gap: z.string().nullable().optional(),
});
export type ClaimAnswer = z.infer<typeof ClaimAnswer>;

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

/**
 * The verdict as the gate leaves it: the model's quality, unless it said `rich` and nothing
 * survived (then `thin`); `off` when it said nothing and nothing survived; `empty` only when
 * the document has no text. The gap is kept when it says something.
 */
export function verdictOf(
  answer: Pick<ClaimAnswer, "quality" | "gap">,
  doc: Document,
  kept: number,
): Verdict {
  const gap = (answer.gap ?? "").replace(/\s+/g, " ").trim();
  const said = answer.quality ?? (kept ? "thin" : "off");
  const quality: Quality = !doc.text.trim()
    ? "empty"
    : said === "rich" && !kept
      ? "thin"
      : said === "empty"
        ? kept
          ? "thin"
          : "off"
        : said;
  return { quality, ...(gap ? { gap } : {}) };
}

/** Every proposal through the gate: findings whose quote is on the document, dropped with why, the verdict. */
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
  return { findings, dropped, verdict: verdictOf(answer, doc, findings.length) };
}

/** The one extractor of v1: claims that quote the document, and a verdict on it. */
export const claimExtractor: Extractor = {
  name: "claim",
  async extract(doc, ask, model) {
    const { value, usage } = await model.ask(claimPrompt(doc, ask), ClaimAnswer);
    return { ...gateFindings(value, doc), ...(usage ? { usage } : {}) };
  },
};
