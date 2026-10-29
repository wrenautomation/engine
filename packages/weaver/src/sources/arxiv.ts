/**
 * arXiv: search through its API, a paper read whole from its HTML page (the PDF when it has
 * none). Both go to export.arxiv.org, the host arXiv names for programs, one call at a time and
 * 3 seconds apart (arxiv.org's robots ask 15). Each hit's snippet leads with what triage
 * weighs first: OpenAlex's citation count (one call per search, open data; a failed call leaves
 * it out), the paper's comment (venue, code), then its abstract. A follow lists what a paper
 * cites (`refs`, Semantic Scholar: OpenAlex holds no reference list for arXiv) or what cites it
 * (`citers`, OpenAlex, most cited first). Free.
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
export const S2 = "https://api.semanticscholar.org/graph/v1/paper";
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
 * Whether an OpenAlex row is the paper. A row may be the published version merged with the
 * preprint (an ACL DOI, not arXiv's), so it is when it names the id anywhere, never a longer id.
 */
const names = (row: unknown, id: string): boolean =>
  new RegExp(`(^|[^\\d])${id.toLowerCase().replace(".", "\\.")}([^\\d]|$)`).test(
    JSON.stringify(row).toLowerCase(),
  );

/** Each id's citation count from OpenAlex's rows. */
export function citedOf(rows: readonly unknown[], ids: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of rows) {
    const count = (row as { cited_by_count?: unknown }).cited_by_count;
    if (typeof count !== "number") continue;
    for (const id of ids) if (!out.has(id) && names(row, id)) out.set(id, count);
  }
  return out;
}

/** OpenAlex keeps an abstract as each word's positions; the words back in order. */
export function abstractOf(index: unknown): string {
  if (!index || typeof index !== "object") return "";
  const at: string[] = [];
  for (const [word, spots] of Object.entries(index as Record<string, unknown>))
    if (Array.isArray(spots)) for (const i of spots) if (typeof i === "number") at[i] = word;
  return at.filter(Boolean).join(" ");
}

const authorLine = (names: readonly string[]): string =>
  names.length > 3 ? `${names.slice(0, 3).join(", ")} et al.` : names.join(", ");

/** A cited or citing work: its arXiv page when it has one, else its DOI, else its landing page. */
export interface Work {
  links: readonly string[];
  doi?: string;
  title?: string;
  authors: readonly string[];
  date?: string;
  cited?: number;
  /** Who counted the citations. */
  by: string;
  /** What triage weighs before the count: why this work is in the list. */
  lead?: string;
  abstract?: string;
}

export function workHit(w: Work): HitViewIn | null {
  let url: string | undefined;
  for (const l of w.links) {
    try {
      const id = arxivId(new URL(l));
      if (id) url = `https://arxiv.org/abs/${id}`;
    } catch {}
    if (url) break;
  }
  url ??= w.doi ? `https://doi.org/${w.doi.replace(/^https?:\/\/doi\.org\//, "")}` : w.links[0];
  if (!url) return null;
  const snippet = [
    w.lead ?? "",
    w.cited !== undefined ? `Cited ${w.cited} times (${w.by}).` : "",
    w.abstract ? `Abstract: ${w.abstract}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const authors = authorLine(w.authors);
  return {
    url,
    ...(w.title ? { title: w.title } : {}),
    ...(authors ? { channel: authors } : {}),
    ...(w.date ? { date: w.date } : {}),
    ...(snippet ? { snippet } : {}),
  };
}

interface OpenAlexRow {
  display_name?: string;
  cited_by_count?: number;
  publication_date?: string;
  ids?: { doi?: string };
  locations?: { landing_page_url?: string | null }[];
  authorships?: { author?: { display_name?: string } }[];
  abstract_inverted_index?: unknown;
}

export const openAlexWork = (r: OpenAlexRow): Work => {
  const abstract = abstractOf(r.abstract_inverted_index);
  return {
    links: (r.locations ?? []).flatMap((l) => (l.landing_page_url ? [l.landing_page_url] : [])),
    ...(r.ids?.doi ? { doi: r.ids.doi } : {}),
    ...(r.display_name ? { title: r.display_name } : {}),
    authors: (r.authorships ?? []).flatMap((a) => a.author?.display_name ?? []),
    ...(r.publication_date ? { date: r.publication_date } : {}),
    ...(typeof r.cited_by_count === "number" ? { cited: r.cited_by_count } : {}),
    by: "OpenAlex",
    ...(abstract ? { abstract } : {}),
  };
};

interface S2Paper {
  paperId?: string;
  title?: string;
  externalIds?: { ArXiv?: string; DOI?: string } | null;
  citationCount?: number;
  publicationDate?: string | null;
  year?: number | null;
  authors?: { name?: string }[];
  abstract?: string | null;
}

export const s2Work = (p: S2Paper): Work => {
  const date = p.publicationDate ?? (p.year ? String(p.year) : undefined);
  return {
    links: [
      ...(p.externalIds?.ArXiv ? [`https://arxiv.org/abs/${p.externalIds.ArXiv}`] : []),
      ...(p.paperId ? [`https://www.semanticscholar.org/paper/${p.paperId}`] : []),
    ],
    ...(p.externalIds?.DOI ? { doi: p.externalIds.DOI } : {}),
    ...(p.title ? { title: p.title } : {}),
    authors: (p.authors ?? []).flatMap((a) => a.name ?? []),
    ...(date ? { date } : {}),
    ...(typeof p.citationCount === "number" ? { cited: p.citationCount } : {}),
    by: "Semantic Scholar",
    ...(p.abstract ? { abstract: p.abstract } : {}),
  };
};

/** A paper as a hit: citations and the comment first, so a clipped snippet keeps them. */
export function paperHit(p: Paper, cited?: number): HitViewIn {
  const lead = [
    cited !== undefined ? `Cited ${cited} times (OpenAlex).` : "",
    p.comment ? `Comment: ${p.comment}` : "",
  ].filter(Boolean);
  const authors = authorLine(p.authors);
  return {
    url: `https://arxiv.org/abs/${p.id}`,
    ...(p.title ? { title: p.title } : {}),
    ...(authors ? { channel: authors } : {}),
    ...(p.published ? { date: p.published } : {}),
    snippet: [...lead, `Abstract: ${p.abstract}`].join(" "),
  };
}

const paperId = (url: string): string | null => {
  try {
    return arxivId(new URL(url));
  } catch {
    return null;
  }
};

export function arxivSource(o: {
  /** The User-Agent with a contact, as arXiv asks. */
  agent: string;
  /** Searches stay inside these, when given. */
  categories?: readonly string[];
  n?: number;
  /** OpenAlex's free key: its own daily budget, not the one shared by every keyless caller. */
  openalexKey?: string;
  /** Semantic Scholar's free key: its own rate, not the pool shared by every keyless caller. */
  s2Key?: string;
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

  // OpenAlex and Semantic Scholar: other hosts, no 3 second rule.
  const api = async (name: string, url: string, headers: Record<string, string> = {}) => {
    const res = await fetchFn(url, {
      headers: { "user-agent": o.agent, ...headers },
      signal: AbortSignal.timeout(15_000),
    }).catch((err) => {
      throw transport(name, err);
    });
    if (!res.ok) throw httpError(name, res);
    return (await res.json()) as Record<string, unknown>;
  };
  const alex = (params: Record<string, string>) =>
    api(
      "openalex",
      `${OPENALEX}?${new URLSearchParams({ ...params, ...(o.openalexKey ? { api_key: o.openalexKey } : {}) })}`,
    );

  const refs = async (id: string, n: number): Promise<HitViewIn[]> => {
    const fields =
      "isInfluential,title,externalIds,citationCount,publicationDate,year,authors,abstract";
    const body = await api(
      "semanticscholar",
      `${S2}/arXiv:${id}/references?fields=${fields}&limit=1000`,
      o.s2Key ? { "x-api-key": o.s2Key } : {},
    );
    // A publisher may hide the list: `data` comes back empty, and the fetch step writes a gap.
    const rows = (
      (body.data as { citedPaper?: S2Paper; isInfluential?: boolean }[] | null) ?? []
    ).filter((r) => r.citedPaper?.title);
    // The works the paper leans on (Semantic Scholar's influence flag) first: the most cited
    // refs are often background (GPT-3), not what the paper builds on.
    rows.sort(
      (a, b) =>
        Number(b.isInfluential ?? false) - Number(a.isInfluential ?? false) ||
        (b.citedPaper?.citationCount ?? 0) - (a.citedPaper?.citationCount ?? 0),
    );
    return rows
      .flatMap((r) => {
        const w = s2Work(r.citedPaper as S2Paper);
        return workHit(r.isInfluential ? { ...w, lead: "The paper leans on it." } : w) ?? [];
      })
      .slice(0, n);
  };

  const citers = async (id: string, n: number): Promise<HitViewIn[]> => {
    const found = await alex({ filter: `doi:10.48550/arxiv.${id}`, select: "id,ids,locations" });
    const work = ((found.results as { id?: string }[] | undefined) ?? []).find((r) => names(r, id));
    const w = work?.id?.split("/").pop();
    if (!w) return [];
    const body = await alex({
      filter: `cites:${w}`,
      sort: "cited_by_count:desc",
      per_page: String(Math.min(n, 200)),
      select:
        "id,ids,display_name,cited_by_count,publication_date,locations,authorships,abstract_inverted_index",
    });
    return ((body.results as OpenAlexRow[] | undefined) ?? []).flatMap(
      (r) => workHit(openAlexWork(r)) ?? [],
    );
  };

  // A count is a hint: a failed call leaves it out.
  const cited = async (ids: readonly string[]): Promise<Map<string, number>> =>
    ids.length
      ? alex({
          filter: `doi:${ids.map((id) => `10.48550/arxiv.${id}`).join("|")}`,
          select: "ids,cited_by_count,locations",
          per_page: "50",
        })
          .then((body) => citedOf((body.results as unknown[] | undefined) ?? [], ids))
          .catch(() => new Map())
      : new Map();

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
    follows: (as, url) => (as === "refs" || as === "citers") && paperId(url) !== null,
    async follow(as, url, n) {
      const id = paperId(url);
      if (!id) throw new Error(`arxiv: not a paper: ${url}`);
      if (as === "refs") return refs(id, n);
      if (as === "citers") return citers(id, n);
      throw new Error(`arxiv follows refs or citers, not ${as}`);
    },
    opens: (url) => paperId(url) !== null,
    async open(h) {
      const id = paperId(h.url);
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
