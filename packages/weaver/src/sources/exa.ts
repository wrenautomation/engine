/**
 * Exa: `POST https://api.exa.ai/search`, a key per call from the ring. Metered: the search, plus
 * one highlight per result (a few sentences Exa picks for the query) as the hit's snippet, so
 * triage has words to go on. Contents bill per result on top of the search.
 */

import { httpError, transport } from "@wrenautomation/models";
import type { Source } from "../engine/ports.js";

interface ExaResult {
  url: string;
  title?: string | null;
  publishedDate?: string | null;
  author?: string | null;
  highlights?: string[] | null;
}

/** What one highlight costs Exa to make: sentences per result. */
export const HIGHLIGHT = { numSentences: 3, highlightsPerUrl: 1 } as const;

export const EXA_SEARCH = "https://api.exa.ai/search";

export function exa(o: { keys: readonly string[]; fetchFn?: typeof fetch; n?: number }): Source {
  if (!o.keys.length) throw new Error("exa: no key");
  const fetchFn = o.fetchFn ?? fetch;
  let turn = 0;
  return {
    name: "exa",
    kind: "search",
    cost: "metered",
    async search(q) {
      const key = o.keys[turn++ % o.keys.length] as string;
      const res = await fetchFn(EXA_SEARCH, {
        method: "POST",
        headers: { "x-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({
          query: q.terms,
          numResults: o.n ?? 10,
          type: "auto",
          contents: { highlights: HIGHLIGHT },
          ...(q.site ? { includeDomains: [q.site] } : {}),
        }),
        signal: AbortSignal.timeout(30_000),
      }).catch((err) => {
        throw transport("exa", err);
      });
      if (!res.ok) throw httpError("exa", res);
      const body = (await res.json()) as { results?: ExaResult[] };
      return (body.results ?? []).map((r) => ({
        url: r.url,
        ...(r.title ? { title: r.title } : {}),
        ...(r.author ? { channel: r.author } : {}),
        ...(r.publishedDate ? { date: r.publishedDate.slice(0, 10) } : {}),
        ...(r.highlights?.[0]?.trim() ? { snippet: r.highlights[0].trim() } : {}),
      }));
    },
  };
}
