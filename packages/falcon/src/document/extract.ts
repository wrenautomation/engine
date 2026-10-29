/**
 * An extractor draws findings out of one document for one ask, and says what the document was
 * worth. The claim extractor is the one in v1: the model proposes sentences with the exact words
 * they rest on; the gate keeps a finding only when its quote is on the document, word for word,
 * and every number in it is in the quote (a year may come from the document). What the model
 * knows without the document never becomes a finding. The verdict is the same call's word on the
 * document (`quality`) and on the ask (`gap`); the gate corrects a `rich` that kept nothing.
 *
 * No cutoff: the prompt caps neither the findings nor their length, and a document is sent
 * whole. When the model's output cap cuts an answer (a `Cut`), the whole findings before the cut
 * go through the gate, and the model is asked again for the text after the last quote it kept,
 * with those findings known. A cut answer with no whole finding on the document stops the
 * extract with an error: the one case a document stays unread.
 */
import { z } from "zod";
import { fill } from "../study/claims.js";
import { numbersQuoted, pageQuoted, words } from "../study/grounding.js";
import { bodyOf } from "./body.js";
import { addUsage, isCut, type Model, type Usage } from "./model.js";
import { type Document, type Finding, Quality, type Verdict } from "./types.js";

/** What the run is after; the same fields raven's `Ask` has, met by structure. */
export interface AskView {
  text: string;
  /** Facts already in hand, one line each: the extractor looks past them. */
  known?: readonly string[];
  /** What the person said along the way, one line each: rendered first, in every prompt. */
  steer?: readonly string[];
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
  /** Model calls past the first: one per cut answer continued. */
  continued?: number;
}

export interface Extractor {
  name: string;
  extract(doc: Document, ask: AskView, model: Model): Promise<Extracted>;
}

const QUOTE_MIN_WORDS = 5;

export const CLAIM_PROMPT = `You pull facts out of one document for a research ask.

Return ONLY a JSON object, no prose, exactly this shape:
{"findings": [{"text": "...", "quote": "..."}], "quality": "rich", "gap": "..."}

Rules:
- Every finding that serves the ask and is not known already, in document order.
- text: one plain sentence a person would say out loud. Specific: a number, a named practice, a stated cause. Never "The document says" or "The page notes".
- Say who says it, as the page shows it: "A 2025 survey of 400 firms found ...", "One commenter says ...", "A vendor of X says ...". One person is one person: never "owners say" or "commenters" for one voice.
- Name a speaker's role, trade, size or place only when the page states it.
- Keep the quote's hedge and scope: "probably", "sometimes", "a lot of", "in my experience" stay; never turn them into "most", "often" or a rule.
- Advice, a question, a promise or a sales pitch is not a report of what happens. Take it only as what it is ("A seller claims ...").
- quote: the exact words from the document that the finding rests on, copied character for character, at least 5 words, no more than the finding needs.
- Every part of the text must be in the quote: no cause, ranking, detail or second fact the quote lacks. Two facts from two places are two findings.
- Every number in the text must appear in the quote. A table cell without its row and column labels is not a quote.
- A company's marketing about itself is not a fact about the market.
- Nothing in the document serves the ask: return {"findings": [], "quality": "off", "gap": "..."}.
- quality: "rich" when the document answers much of the ask, "thin" when it serves it a little, "off" when it is about something else.
- gap: one short sentence on what the ask still lacks after this document, or an empty string when nothing is missing.

Ask: {ask}
{steer}Known already (look past these):
{known}

DOCUMENT: {url}{part}
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

/** "The person says:" and their lines, or nothing: a prompt pays for the heading only when there is one. */
export const renderSteer = (steer: readonly string[] | undefined): string =>
  steer?.length ? `The person says:\n${steer.map((s) => `- ${s}`).join("\n")}\n` : "";

export function claimPrompt(doc: Document, ask: AskView, options: { rest?: boolean } = {}): string {
  const known = ask.known ?? [];
  return fill(CLAIM_PROMPT, {
    ask: ask.text,
    steer: renderSteer(ask.steer),
    known: known.length ? known.map((k) => `- ${k}`).join("\n") : "(nothing)",
    url: doc.url,
    part: options.rest ? " (the rest, after the last finding kept)" : "",
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
  for (const p of answer.findings) {
    const text = (p.text ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const quote = (p.quote ?? "").trim();
    // A short quote proves little (it is on many pages); a line break inside one folds to a space.
    const why = !quote
      ? "no_quote"
      : words(quote) < QUOTE_MIN_WORDS
        ? "quote_short"
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

/**
 * The whole findings in a cut answer: each complete `{...}` of the findings array, in order, up
 * to the first that does not parse. Braces and quotes inside strings are not structure.
 */
export function salvageFindings(partial: string): ClaimAnswer {
  const findings: ClaimAnswer["findings"] = [];
  const key = partial.indexOf('"findings"');
  const open = key >= 0 ? partial.indexOf("[", key) : -1;
  if (open < 0) return { findings };
  let i = open + 1;
  while (i < partial.length) {
    const start = partial.indexOf("{", i);
    if (start < 0) break;
    let depth = 0;
    let inString = false;
    let end = -1;
    for (let j = start; j < partial.length; j++) {
      const c = partial[j];
      if (inString) {
        if (c === "\\") j++;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        end = j;
        break;
      } else if (c === "]" && depth === 0) break;
    }
    if (end < 0) break;
    const one = ClaimAnswer.shape.findings.element.safeParse(
      JSON.parse(partial.slice(start, end + 1)),
    );
    if (!one.success) break;
    findings.push(one.data);
    i = end + 1;
  }
  return { findings };
}

const RANK: Record<Quality, number> = { rich: 3, thin: 2, off: 1, empty: 0 };

/** Where a quote ends in the text, at or after `from`; -1 when the text does not hold it as written. */
function quoteEnd(text: string, quote: string, from: number): number {
  const q = quote.replace(/\s+/g, " ").trim();
  let at = text.indexOf(q, from);
  if (at < 0) at = text.toLowerCase().indexOf(q.toLowerCase(), from);
  return at < 0 ? -1 : at + q.length;
}

/**
 * The one extractor of v1: claims that quote the document, and a verdict on it. A cut answer
 * is continued from the end of the last quote it kept, with those findings known, until the
 * model finishes an answer.
 */
export const claimExtractor: Extractor = {
  name: "claim",
  async extract(whole, ask, model) {
    // the reference list holds no finding: every part and quote comes from the body
    const doc: Document = { ...whole, text: bodyOf(whole.text) };
    const findings: Finding[] = [];
    const dropped: Dropped[] = [];
    const known = [...(ask.known ?? [])];
    let usage: Usage | undefined;
    let from = 0;
    let best: Quality | null = null;
    let continued = 0;
    for (;;) {
      const part: Document = from ? { ...doc, text: doc.text.slice(from) } : doc;
      let answer: ClaimAnswer;
      let cut = false;
      try {
        const a = await model.ask(
          claimPrompt(part, { ...ask, known }, { rest: from > 0 }),
          ClaimAnswer,
        );
        answer = a.value;
        usage = addUsage(usage, a.usage);
      } catch (err) {
        if (!isCut(err)) throw err;
        cut = true;
        answer = salvageFindings(err.partial);
        usage = addUsage(usage, err.usage);
      }
      const out = gateFindings(answer, part);
      const fresh = out.findings.filter(
        (f) => !findings.some((k) => k.proof.quote === f.proof.quote),
      );
      findings.push(...fresh);
      dropped.push(...out.dropped);
      if (answer.quality && (!best || RANK[answer.quality] > RANK[best])) best = answer.quality;
      if (!cut) {
        return {
          findings,
          dropped,
          verdict: verdictOf({ quality: best, gap: answer.gap }, doc, findings.length),
          ...(usage ? { usage } : {}),
          ...(continued ? { continued } : {}),
        };
      }
      const next = fresh.reduce(
        (end, f) => Math.max(end, quoteEnd(doc.text, f.proof.quote ?? "", from)),
        -1,
      );
      if (next <= from)
        throw new Error(
          `the answer was cut and ${fresh.length ? "no kept quote places the cut" : "nothing before the cut passed the gate"} (${doc.url}, from ${from})`,
        );
      for (const f of fresh) known.push(f.text);
      from = next;
      continued++;
    }
  },
};
