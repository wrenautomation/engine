/** SearXNG: a self-hosted metasearch, `GET $url/search?q=&format=json`. Free. */
import type { Source } from "../engine/ports.js";

interface SearxResult {
  url?: string;
  title?: string;
  content?: string;
  publishedDate?: string | null;
}

export function searxng(o: { url: string; fetchFn?: typeof fetch; n?: number }): Source {
  const fetchFn = o.fetchFn ?? fetch;
  const base = o.url.replace(/\/$/, "");
  return {
    name: "searxng",
    kind: "search",
    cost: "free",
    async search(q) {
      const u = new URL(`${base}/search`);
      u.searchParams.set("q", q.site ? `site:${q.site} ${q.terms}` : q.terms);
      u.searchParams.set("format", "json");
      const res = await fetchFn(u, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`searxng: HTTP ${res.status}`);
      const body = (await res.json()) as { results?: SearxResult[] };
      return (body.results ?? [])
        .filter((r): r is SearxResult & { url: string } => typeof r.url === "string")
        .slice(0, o.n ?? 10)
        .map((r) => ({
          url: r.url,
          ...(r.title ? { title: r.title } : {}),
          ...(r.content ? { snippet: r.content } : {}),
          ...(r.publishedDate ? { date: r.publishedDate.slice(0, 10) } : {}),
        }));
    },
  };
}
