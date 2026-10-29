/** A document without the parts no question needs: its reference list. */

/** A heading line on its own: `## References`, `7 References`, `Appendix A More Results`. */
const heading = (words: string, more = "") =>
  new RegExp(`\\n(?:#+ *)?(?:\\d+\\.? +)?(?:${words})${more} *\\n`, "g");

/**
 * The page without its reference list: from the last References or Bibliography heading to the
 * next Appendix heading, or to the end. A list of citations answers no question and holds no finding.
 */
export function bodyOf(text: string): string {
  const refs = [...text.matchAll(heading("References|Bibliography"))].at(-1);
  if (refs?.index === undefined) return text;
  const after = refs.index + refs[0].length;
  const next = heading("Appendix", "\\b[^\\n]{0,80}");
  next.lastIndex = after;
  const app = next.exec(text);
  return text.slice(0, refs.index) + (app ? text.slice(app.index) : "");
}
