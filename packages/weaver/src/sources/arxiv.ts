/**
 * arXiv: search through its API, a paper read whole from its HTML page (the PDF when it has
 * none). Both go to export.arxiv.org, the host arXiv names for programs, one call at a time and
 * 3 seconds apart (arxiv.org's robots ask 15). Each hit's snippet leads with what triage
 * weighs first: OpenAlex's citation count (one call per search, open data; a failed call leaves
 * it out), the paper's comment (venue, code), then its abstract. Free.
 */
import { defaultReaders, type Media, type Reader } from "@wrenautomation/falcon/document";
import { httpError, transientStatus, transport } from "@wrenautomation/models";
import type { HitViewIn } from "@wrenautomation/raven";
import { DomUtils, parseDocument } from "htmlparser2";
import { arxivId } from "../engine/canonical.js";
import type { Source } from "../engine/ports.js";
import { readResponse } from "./fetcher.js";

export const ARXIV = "https://export.arxiv.org";
export const OPENALEX = "https://api.openalex.org/works";
/** arXiv's rule for programs: one call every 3 seconds at most. */
export const ARXIV_GAP_MS = 3_000;

const STOP = new Set(
  "a an and are as at be by can do does for from how in into is it of on or that the their this to under what when which who why with without".split(
    " ",
  ),
);

/**
 * The terms as arXiv's query: every content word in any field (`any`: one of them), inside the
 * categories when given (`cs.AI`, `cs.CL`).
 */
export function arxivQuery(terms: string, categories: readonly string[] = [], any = false): string {
  const words = [
    ...new Set(terms.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu) ?? []),
  ].filter((w) => w.length > 1 && !STOP.has(w));
  if (!words.length) throw new Error(`arxiv: no words to search in "${terms}"`);
  const body = words.map((w) => `all:"${w}"`).join(any ? " OR " : " AND ");
  const cats = categories.map((c) => `cat:${c}`).join(" OR ");
  return cats ? `(${body}) AND (${cats})` : body;
}

export interface Paper {
  id: string;
  title: string;
  abstract: string;
  authors: string[];
  published?: string;
  comment?: string;
}

const flat = (s: string) => s.replace(/\s+/g, " ").trim();

/** The API's Atom feed as papers, and how many matched in all. */
export function feedPapers(xml: string): { total: number; papers: Paper[] } {
  const doc = parseDocument(xml, { xmlMode: true });
  const one = (name: string, under: Parameters<typeof DomUtils.getElementsByTagName>[1]) => {
    const [el] = DomUtils.getElementsByTagName(name, under, true, 1);
    return el ? flat(DomUtils.textContent(el)) : "";
  };
  const papers = DomUtils.getElementsByTagName("entry", doc).flatMap((e): Paper[] => {
    let id: string | null = null;
    try {
      id = arxivId(new URL(one("id", e)));
    } catch {}
    if (!id) return [];
    const published = one("published", e).slice(0, 10);
    const comment = one("arxiv:comment", e);
    return [
      {
        id,
        title: one("title", e),
        abstract: one("summary", e),
        authors: DomUtils.getElementsByTagName("author", e).map((a) => one("name", a)),
        ...(published ? { published } : {}),
        ...(comment ? { comment } : {}),
      },
    ];
  });
  return { total: Number(one("opensearch:totalResults", doc)) || 0, papers };
}

/**
 * Each id's citation count from OpenAlex's rows. A row may be the published version merged with
 * the preprint (an ACL DOI, not arXiv's), so an id matches the row that names it anywhere.
 */
export function citedOf(rows: readonly unknown[], ids: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of rows) {
    const count = (row as { cited_by_count?: unknown }).cited_by_count;
    if (typeof count !== "number") continue;
    const text = JSON.stringify(row).toLowerCase();
    for (const id of ids)
      if (
        !out.has(id) &&
        new RegExp(`(^|[^\\d])${id.toLowerCase().replace(".", "\\.")}([^\\d]|$)`).test(text)
      )
        out.set(id, count);
  }
  return out;
}

/** A paper as a hit: citations and the comment first, so a clipped snippet keeps them. */
export function paperHit(p: Paper, cited?: number): HitViewIn {
  const lead = [
    cited !== undefined ? `Cited ${cited} times (OpenAlex).` : "",
    p.comment ? `Comment: ${p.comment}` : "",
  ].filter(Boolean);
  const authors =
    p.authors.length > 3 ? `${p.authors.slice(0, 3).join(", ")} et al.` : p.authors.join(", ");
  return {
    url: `https://arxiv.org/abs/${p.id}`,
    ...(p.title ? { title: p.title } : {}),
    ...(authors ? { channel: authors } : {}),
    ...(p.published ? { date: p.published } : {}),
    snippet: [...lead, `Abstract: ${p.abstract}`].join(" "),
  };
}

export function arxivSource(o: {
  /** The User-Agent with a contact, as arXiv asks. */
  agent: string;
  /** Searches stay inside these, when given. */
  categories?: readonly string[];
  n?: number;
  /** OpenAlex's free key: its own daily budget, not the one shared by every keyless caller. */
  openalexKey?: string;
  fetchFn?: typeof fetch;
  readers?: Map<Media, Reader>;
  gapMs?: number;
}): Source {
  const fetchFn = o.fetchFn ?? fetch;
  const readers = o.readers ?? defaultReaders();
  const gap = o.gapMs ?? ARXIV_GAP_MS;
  let chain: Promise<unknown> = Promise.resolve();
  let last = Number.NEGATIVE_INFINITY;
  // One arXiv call at a time, `gap` after the last one ended.
  const paced = (url: string): Promise<Response> => {
    const run = chain.then(async () => {
      const wait = last + gap - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try {
        return await fetchFn(url, {
          headers: { "user-agent": o.agent },
          signal: AbortSignal.timeout(60_000),
        }).catch((err) => {
          throw transport("arxiv", err);
        });
      } finally {
        last = Date.now();
      }
    });
    chain = run.catch(() => {});
    return run;
  };

  const search = async (query: string, n: number) => {
    const url = `${ARXIV}/api/query?${new URLSearchParams({
      search_query: query,
      start: "0",
      max_results: String(n),
      sortBy: "relevance",
    })}`;
    const res = await paced(url);
    if (!res.ok) throw httpError("arxiv", res);
    return feedPapers(await res.text());
  };

  const cited = async (ids: readonly string[]): Promise<Map<string, number>> => {
    if (!ids.length) return new Map();
    const params = new URLSearchParams({
      filter: `doi:${ids.map((id) => `10.48550/arxiv.${id}`).join("|")}`,
      select: "ids,cited_by_count,locations",
      per_page: "50",
      ...(o.openalexKey ? { api_key: o.openalexKey } : {}),
    });
    try {
      const res = await fetchFn(`${OPENALEX}?${params}`, {
        headers: { "user-agent": o.agent },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return new Map();
      return citedOf(((await res.json()) as { results?: unknown[] }).results ?? [], ids);
    } catch {
      return new Map();
    }
  };

  return {
    name: "arxiv",
    kind: "both",
    cost: "free",
    first: true,
    keeps: (site) => /(^|\.)arxiv\.org$/.test(site),
    async search(q) {
      const n = o.n ?? 15;
      // Every word first; short of n, the rest from any of them, by relevance.
      const papers = (await search(arxivQuery(q.terms, o.categories), n)).papers;
      if (papers.length < n) {
        const have = new Set(papers.map((p) => p.id));
        const more = (await search(arxivQuery(q.terms, o.categories, true), n)).papers;
        papers.push(...more.filter((p) => !have.has(p.id)).slice(0, n - papers.length));
      }
      const counts = await cited(papers.map((p) => p.id));
      return papers.map((p) => paperHit(p, counts.get(p.id)));
    },
    opens: (url) => {
      try {
        return arxivId(new URL(url)) !== null;
      } catch {
        return false;
      }
    },
    async open(h) {
      let id: string | null = null;
      try {
        id = arxivId(new URL(h.url));
      } catch {}
      if (!id) throw new Error(`arxiv: not a paper: ${h.url}`);
      // The HTML keeps tables and sections; older papers have only the PDF.
      let res = await paced(`${ARXIV}/html/${id}`);
      let shown = `https://arxiv.org/html/${id}`;
      if (res.status === 404) {
        await res.body?.cancel().catch(() => {});
        res = await paced(`${ARXIV}/pdf/${id}`);
        shown = `https://arxiv.org/pdf/${id}`;
      }
      if (transientStatus(res.status)) throw httpError("arxiv", res);
      const doc = await readResponse(res, shown, readers, h, "arxiv");
      return { ...doc, url: shown };
    },
  };
}
