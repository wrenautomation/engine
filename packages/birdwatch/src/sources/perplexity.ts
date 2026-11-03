/**
 * Perplexity Search: `POST https://api.perplexity.ai/search`, a key per call from the ring.
 * Perplexity's own index, raw results with a snippet, no synthesis. Metered per request, not
 * per token: `fast` is $1 per 1K requests (`web` $5). The answer carries no cost, so the
 * spend takes the list price.
 */

import { httpError, transport } from "@wrenautomation/models";
import type { Source } from "../engine/ports.js";

interface PerplexityResult {
  url: string;
  title?: string | null;
  snippet?: string | null;
  date?: string | null;
}

export const PERPLEXITY_SEARCH = "https://api.perplexity.ai/search";
/** List price of one `fast` request, USD (docs.perplexity.ai/guides/pricing). */
export const PERPLEXITY_FAST_USD = 0.001;
/** Content tokens kept per result: a snippet's worth, which is what triage reads. */
const TOKENS_PER_PAGE = 256;

const hitOf = (r: PerplexityResult) => ({
  url: r.url,
  ...(r.title ? { title: r.title } : {}),
  ...(r.date ? { date: r.date.slice(0, 10) } : {}),
  ...(r.snippet?.trim() ? { snippet: r.snippet.trim() } : {}),
});

export function perplexity(o: {
  keys: readonly string[];
  fetchFn?: typeof fetch;
  n?: number;
}): Source {
  if (!o.keys.length) throw new Error("perplexity: no key");
  const fetchFn = o.fetchFn ?? fetch;
  let turn = 0;
  return {
    name: "perplexity",
    kind: "search",
    cost: "metered",
    async search(q) {
      const key = o.keys[turn++ % o.keys.length] as string;
      const res = await fetchFn(PERPLEXITY_SEARCH, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({
          query: q.terms,
          max_results: o.n ?? 10,
          search_type: "fast",
          max_tokens_per_page: TOKENS_PER_PAGE,
          ...(q.site ? { search_domain_filter: [q.site] } : {}),
        }),
        signal: AbortSignal.timeout(30_000),
      }).catch((err) => {
        throw transport("perplexity", err);
      });
      if (!res.ok) throw httpError("perplexity", res);
      const out = (await res.json()) as { results?: PerplexityResult[] };
      const hits = (out.results ?? [])
        .filter((r): r is PerplexityResult => typeof r.url === "string")
        .map(hitOf);
      // the spend reads it, as with Exa
      return Object.assign(hits, { usd: PERPLEXITY_FAST_USD });
    },
  };
}
