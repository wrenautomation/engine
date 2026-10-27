/**
 * What the model is shown of a page: the passages that match the question's terms, within a
 * budget. Pure. Which pages to read is raven's triage now (0.5.0).
 */
import { type EvidencePage, foldText } from "./grounding.js";

const STOP = new Set(
  "about after also been being between both could does doing each from have having here into more most much only other over same should some such than that their them then there these they this those through under very what when where which while with would your year years".split(
    " ",
  ),
);

/** The words worth matching in a question: four letters or more, not filler. */
export function terms(...texts: string[]): Set<string> {
  return new Set(
    texts
      .flatMap((t) => foldText(t).split(/[^\p{L}\d]+/u))
      .filter((w) => w.length >= 4 && !STOP.has(w)),
  );
}

const CHUNK = 600;

/** Lines packed into chunks of about CHUNK characters, in page order. */
function chunks(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const line of text.split(/\n+/)) {
    const l = line.trim();
    if (!l) continue;
    if (cur && cur.length + l.length > CHUNK) {
      out.push(cur);
      cur = "";
    }
    cur = cur ? `${cur}\n${l}` : l;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * The parts of a page worth showing for these terms, in page order, within
 * `budget` characters. A chunk scores a point per term it has, and one more
 * when it has a number (a study wants figures). A short page is shown whole.
 */
export function passages(text: string, want: ReadonlySet<string>, budget: number): string {
  if (text.length <= budget) return text;
  const parts = chunks(text).map((c, i) => {
    const words = new Set(foldText(c).split(/[^\p{L}\d]+/u));
    let score = /\d/.test(c) ? 1 : 0;
    for (const t of want) if (words.has(t)) score++;
    return { i, c, score };
  });
  const picked: typeof parts = [];
  let used = 0;
  for (const p of [...parts].sort((a, b) => b.score - a.score || a.i - b.i)) {
    if (p.score === 0) break;
    if (used + p.c.length > budget) continue;
    picked.push(p);
    used += p.c.length + 2;
  }
  if (!picked.length) return text.slice(0, budget);
  return picked
    .sort((a, b) => a.i - b.i)
    .map((p) => p.c)
    .join("\n\n");
}

/** How much of one page the model is shown: its best passages for every angle. */
export const PAGE_CHARS = 12_000;

/** The part of one page its claims are drawn from. */
export const pageEvidence = (page: EvidencePage, want: ReadonlySet<string>): EvidencePage => ({
  url: page.url,
  text: passages(page.text, want, PAGE_CHARS),
});
