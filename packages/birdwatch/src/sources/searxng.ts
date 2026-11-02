/**
 * SearXNG: a self-hosted metasearch, `GET $url/search?q=&format=json`. Free. `token` goes as a
 * bearer for an instance behind an authenticating proxy (Wren's, on the VPS).
 */

import { httpError, transport } from "@wrenautomation/models";
import type { Source } from "../engine/ports.js";

interface SearxResult {
  url?: string;
  title?: string;
  content?: string;
  publishedDate?: string | null;
}

export function searxng(o: {
  url: string;
  token?: string;
  fetchFn?: typeof fetch;
  n?: number;
}): Source {
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
      const res = await fetchFn(u, {
        // Wren's instance queues a burst up to 60 s (deploy/vps/search.nginx)
        signal: AbortSignal.timeout(90_000),
        ...(o.token ? { headers: { authorization: `Bearer ${o.token}` } } : {}),
      }).catch((err) => {
        throw transport("searxng", err);
      });
      if (!res.ok) throw httpError("searxng", res);
      const body = (await res.json()) as {
        results?: SearxResult[];
        unresponsive_engines?: [string, string][];
      };
      const down = body.unresponsive_engines ?? [];
      // empty because its engines refused (rate limit, CAPTCHA): a failed search, not "no results"
      if (!body.results?.length && down.length)
        throw new Error(
          `searxng: no engine answered: ${down.map(([e, why]) => `${e} (${why})`).join(", ")}`,
        );
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
