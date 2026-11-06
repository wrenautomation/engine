/**
 * A person's pasted finds: lines of a URL and why it matters, in any order on the line.
 *
 *   https://youtu.be/abc  his hook structure
 *   his pricing page: https://site.example/pricing
 *   https://instagram.com/reel/x
 *   the caption formula, read the comments too
 *
 * A line with no URL goes on the why of the URL line above it. `#` lines and blank lines are skipped.
 */
export interface Find {
  url: string;
  why: string;
}

const LINK = /https?:\/\/\S+/g;
/** Marks a paste leaves around a URL or a note: bullets, dashes, colons. */
const EDGE = /^[\s\-\u2013\u2014:|,;>*\u2022]+|[\s\-\u2013\u2014:|,;]+$/g;

/** `shared`: the why of a URL the lines give none. Throws on a URL with no why at all. */
export function findsOf(text: string, shared?: string): Find[] {
  const out: Find[] = [];
  let last: Find[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const urls = (line.match(LINK) ?? []).map((u) => u.replace(/[),.;\]>"']+$/, ""));
    const note = line.replace(LINK, " ").replace(/\s+/g, " ").replace(EDGE, "");
    if (!urls.length) {
      if (!last.length) throw new Error(`open --lines: no URL on or above "${line}"`);
      for (const f of last) f.why = f.why ? `${f.why} ${note}` : note;
      continue;
    }
    last = urls.map((url) => ({ url, why: note }));
    out.push(...last);
  }
  if (!out.length) throw new Error("open --lines: no URL in the lines");
  const rest = shared?.trim();
  const bare = out.filter((f) => !f.why);
  if (bare.length && !rest)
    throw new Error(
      `open --lines: no why for ${bare.map((f) => f.url).join(", ")}: write it beside the URL, or pass --why for these`,
    );
  for (const f of bare) f.why = rest as string;
  // one find a URL: the first line that names it
  const seen = new Set<string>();
  return out.filter((f) => !seen.has(f.url) && seen.add(f.url));
}
