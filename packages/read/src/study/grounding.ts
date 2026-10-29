/**
 * Cite or drop: a model's claim stands only on words we can find on a page we
 * read. Openers and studies share these checks, so "grounded" means one thing.
 */

/** A page as the model was shown it: its URL and the text it saw (already cut). */
export interface EvidencePage {
  url: string;
  text: string;
}

/**
 * Case, whitespace, curly quotes/dashes and markdown folded, so a faithful copy
 * matches: pages arrive as markdown ("**over 60%**", "[report](https://…)") and
 * models quote the words without the marks.
 */
export function foldText(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/!?\[([^\]]*)\]\([^)\s]*\)/g, "$1")
    .replace(/[*_`]+/g, "")
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** The numbers in a text, thousands commas and trailing stops dropped: "1,200." → "1200". */
export const numbers = (s: string): string[] =>
  (s.match(/\d[\d,.]*/g) ?? []).map((n) => n.replace(/[,.]+$/, "").replace(/,/g, ""));

export const words = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;

/**
 * The folded quote is on the folded page word for word, or each of its sentences
 * is: the model often joins two sentences from one page into one quote.
 */
function quotedFrom(quote: string, page: string): boolean {
  if (page.includes(quote)) return true;
  const sentences = quote
    .split(/(?<=[.;·])\s+/)
    .map((f) => f.replace(/[\s.;·]+$/, ""))
    .filter(Boolean);
  return sentences.length > 1 && sentences.every((f) => page.includes(f));
}

/**
 * The page a quote is on: the one the model named first, then any page shown
 * (a wrong URL is fixed, not fatal). Null when no page has it.
 */
export function pageQuoted(
  quote: string,
  pages: readonly EvidencePage[],
  namedUrl: string | null,
): EvidencePage | null {
  const folded = foldText(quote);
  const named = pages.find((p) => p.url === namedUrl);
  return (
    [...(named ? [named] : []), ...pages].find((p) => quotedFrom(folded, foldText(p.text))) ?? null
  );
}

const YEAR = /^(19|20)\d\d$/;

/**
 * Every number in `claim` is in `quote`. A year may instead come from the page
 * the quote is on, its URL or text: "Level CFO's 2026 benchmarks" names the
 * report, and the quote rarely repeats it.
 */
export const numbersQuoted = (claim: string, quote: string, page?: EvidencePage): boolean => {
  const inQuote = new Set(numbers(quote));
  const onPage = new Set(page ? numbers(`${page.url} ${page.text}`) : []);
  return numbers(claim).every((n) => inQuote.has(n) || (YEAR.test(n) && onPage.has(n)));
};
