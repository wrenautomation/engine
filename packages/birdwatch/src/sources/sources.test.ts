import type { LadderClient } from "@wrenautomation/read/fetch";
import { describe, expect, it } from "vitest";
import { canonical } from "../engine/canonical.js";
import { MemoryLedger } from "../ledger/memory.js";
import type { HitRecord, QueryRecord } from "../ledger/records.js";
import {
  abstractOf,
  arxivQuery,
  arxivSource,
  citedOf,
  entryHit,
  exa,
  fetcherSource,
  googleSource,
  httpLadderClient,
  ingressLadderClient,
  LadderCallError,
  ladderSource,
  ledgerSource,
  overviewUrl,
  paste,
  postsOf,
  searxng,
  ytdlpSource,
} from "./index.js";

const base = {
  id: "r-1",
  run: "run-a",
  round: 1,
  at: "2026-10-27T00:00:00.000Z",
  from: "ai" as const,
  by: "m",
};
const query = (terms: string, site?: string): QueryRecord => ({
  ...base,
  type: "query",
  kind: "web",
  terms,
  why: "test",
  ...(site ? { site } : {}),
});
const hit = (url: string, more: Partial<HitRecord> = {}): HitRecord => ({
  ...base,
  type: "hit",
  url,
  key: url,
  sources: ["x"],
  queries: ["r-1"],
  ...more,
});

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

describe("searxng", () => {
  it("asks for JSON, prefixes a site, maps the free fields", async () => {
    const seen: string[] = [];
    const src = searxng({
      url: "http://searx.local/",
      n: 1,
      fetchFn: async (u) => {
        seen.push(String(u));
        return json({
          results: [
            {
              url: "https://a.example/x",
              title: "A",
              content: "about a",
              publishedDate: "2026-01-02T10:00:00",
            },
            { url: "https://b.example/y", title: "B" },
          ],
        });
      },
    });
    const hits = await src.search?.(query("staffing margins", "example.com"));
    expect(seen[0]).toBe(
      "http://searx.local/search?q=site%3Aexample.com+staffing+margins&format=json",
    );
    expect(hits).toEqual([
      { url: "https://a.example/x", title: "A", snippet: "about a", date: "2026-01-02" },
    ]);
  });
});

describe("exa", () => {
  it("rotates keys and narrows to the site", async () => {
    const calls: { key: string | null; body: unknown }[] = [];
    const src = exa({
      keys: ["k1", "k2"],
      fetchFn: async (_u, init) => {
        calls.push({
          key: new Headers(init?.headers).get("x-api-key"),
          body: JSON.parse(String(init?.body)),
        });
        return json({
          results: [
            {
              url: "https://c.example",
              title: "C",
              author: "Cy",
              publishedDate: "2025-12-31T00:00:00.000Z",
              highlights: [" Exit interviews show why people leave. "],
            },
          ],
        });
      },
    });
    const q = query("exit interviews", "example.com");
    const first = await src.search?.(q);
    await src.search?.(query("more"));
    await src.search?.(query("again"));
    expect(calls.map((c) => c.key)).toEqual(["k1", "k2", "k1"]);
    expect(calls[0]?.body).toEqual({
      query: "exit interviews",
      numResults: 10,
      type: "auto",
      contents: { highlights: { numSentences: 3, highlightsPerUrl: 1 } },
      includeDomains: ["example.com"],
    });
    expect(first).toEqual([
      {
        url: "https://c.example",
        title: "C",
        channel: "Cy",
        date: "2025-12-31",
        snippet: "Exit interviews show why people leave.",
      },
    ]);
    expect(() => exa({ keys: [] })).toThrow("no key");
  });

  it("follows a page to pages like it, off the page's own site", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const src = exa({
      keys: ["k"],
      fetchFn: async (u, init) => {
        calls.push({ url: String(u), body: JSON.parse(String(init?.body)) });
        return json({ results: [{ url: "https://d.example", title: "D" }] });
      },
    });
    expect(src.follows?.("similar", "https://c.example")).toBe(true);
    expect(src.follows?.("posts", "https://c.example")).toBe(false);
    expect(await src.follow?.("similar", "https://c.example", 5)).toEqual([
      { url: "https://d.example", title: "D" },
    ]);
    expect(calls).toEqual([
      {
        url: "https://api.exa.ai/findSimilar",
        body: {
          url: "https://c.example",
          numResults: 5,
          excludeSourceDomain: true,
          contents: { highlights: { numSentences: 3, highlightsPerUrl: 1 } },
        },
      },
    ]);
  });
});

describe("google", () => {
  it("each result a hit; the AI Overview one hit of its own, each page it cites a hit", async () => {
    const asked: unknown[] = [];
    const src = googleSource({
      sites: {
        async call<T>(site: string, _m: string, path: string, input?: unknown) {
          asked.push({ site, path, input });
          return {
            overview: {
              text: " Most firms win repeat clients by account reviews. ",
              sources: [
                { title: "S", url: "https://s.example/a" },
                { title: "none", url: null },
              ],
            },
            results: [
              { title: "R", url: "https://r.example", snippet: "s", date: "Aug 21, 2026" },
              { title: "no url", url: null },
              { title: "R2", url: "https://r2.example", date: "3 days ago" },
            ],
            questions: ["Why do clients stay?"],
          } as T;
        },
      },
    });
    const got = await src.search?.(query("repeat clients", "reddit.com"));
    expect(asked).toEqual([
      { site: "web", path: "/google", input: { q: "repeat clients site:reddit.com", n: 10 } },
    ]);
    expect(got).toEqual([
      { url: "https://r.example", title: "R", snippet: "s", date: "2026-08-21" },
      { url: "https://r2.example", title: "R2" },
      {
        url: overviewUrl("repeat clients site:reddit.com"),
        title: "Google AI Overview: repeat clients site:reddit.com",
        channel: "Google AI Overview",
        snippet:
          "Most firms win repeat clients by account reviews.\n\nPeople also ask: Why do clients stay?",
      },
      { url: "https://s.example/a", title: "S", snippet: "Cited by Google's AI Overview" },
    ]);
    expect(overviewUrl("a b")).toBe("https://www.google.com/search?q=a%20b#ai-overview");
  });
});

describe("fetcher", () => {
  const html = `<html><head><title>Hello</title></head><body><main><h1>Hello</h1><p>${"word ".repeat(60)}</p></main></body></html>`;
  const opener = (status: number, body: string, type: string) => ({
    open: async (url: string) =>
      new Response(body, { status, headers: { "content-type": type, "x-url": url } }),
  });
  it("reads an html page as a document and carries the hit's free fields", async () => {
    const src = fetcherSource({ fetcher: opener(200, html, "text/html; charset=utf-8") });
    const doc = await src.open?.(hit("https://d.example/p", { channel: "D", date: "2026-02-03" }));
    expect(doc?.media).toBe("html");
    expect(doc?.url).toBe("https://d.example/p");
    expect(doc?.channel).toBe("D");
    expect(doc?.date).toBe("2026-02-03");
    expect(doc?.text).toContain("word");
  });
  it("opens only pages; a 4xx or a video is a miss with its reason", async () => {
    const src = fetcherSource({ fetcher: opener(200, html, "text/html") });
    expect(src.opens?.("https://www.youtube.com/watch?v=abc123def45")).toBe(false);
    expect(src.opens?.("ftp://d.example/v")).toBe(false);
    expect(src.opens?.("https://d.example/p")).toBe(true);
    await expect(
      fetcherSource({ fetcher: opener(404, "no", "text/html") }).open?.(
        hit("https://d.example/gone"),
      ),
    ).rejects.toThrow("fetcher: HTTP 404");
    await expect(
      fetcherSource({ fetcher: opener(200, "x", "video/mp4") }).open?.(hit("https://d.example/v")),
    ).rejects.toThrow("fetcher: no reader for video");
  });
});

describe("arxiv", () => {
  it("matches an id inside a merged work, never a longer id", () => {
    const rows = [
      {
        cited_by_count: 603,
        ids: { doi: "https://doi.org/10.18653/v1/x" },
        locations: [{ landing_page_url: "https://arxiv.org/abs/2210.03629v3" }],
      },
      { cited_by_count: 7, locations: [{ landing_page_url: "https://arxiv.org/abs/2210.036291" }] },
      { ids: {}, locations: [{ landing_page_url: "https://arxiv.org/abs/2401.00001" }] },
    ];
    expect([...citedOf(rows, ["2210.03629", "2210.0362", "2401.00001"])]).toEqual([
      ["2210.03629", 603],
    ]);
  });

  it("follows what a paper cites (Semantic Scholar) and what cites it (OpenAlex)", async () => {
    expect(abstractOf({ gain: [2], We: [0], report: [1] })).toBe("We report gain");
    const asked: string[] = [];
    const src = arxivSource({
      agent: "birdwatch test",
      gapMs: 0,
      s2Key: "k2",
      fetchFn: async (input, init) => {
        const url = String(input);
        asked.push(url);
        if (url.startsWith("https://api.semanticscholar.org")) {
          expect(new Headers(init?.headers).get("x-api-key")).toBe("k2");
          return json({
            data: [
              { citedPaper: { title: "Rare", citationCount: 3, externalIds: { DOI: "10.1/r" } } },
              {
                isInfluential: true,
                citedPaper: {
                  paperId: "abc",
                  title: "WebShop",
                  citationCount: 40,
                  externalIds: {},
                },
              },
              {
                citedPaper: {
                  title: "Chain of thought",
                  citationCount: 900,
                  externalIds: { ArXiv: "2201.11903" },
                  year: 2022,
                  authors: [{ name: "Jason Wei" }],
                  abstract: "Prompting with steps.",
                },
              },
              { citedPaper: { title: null } },
            ],
          });
        }
        const filter = new URL(url).searchParams.get("filter");
        if (filter?.startsWith("doi:"))
          return json({
            results: [
              { id: "https://openalex.org/W9", locations: [{ landing_page_url: "x/2210.036291" }] },
              {
                id: "https://openalex.org/W1",
                ids: { doi: "https://doi.org/10.48550/arxiv.2210.03629" },
              },
            ],
          });
        return json({
          results: [
            {
              display_name: "Agents survey",
              cited_by_count: 965,
              publication_date: "2025-01-17",
              ids: { doi: "https://doi.org/10.1007/s1" },
              locations: [
                { landing_page_url: "https://doi.org/10.1007/s1" },
                { landing_page_url: "http://arxiv.org/abs/2309.07864" },
              ],
              authorships: [{ author: { display_name: "Zhiheng Xi" } }],
              abstract_inverted_index: { Agents: [0], act: [1] },
            },
            { display_name: "No arXiv copy", ids: { doi: "https://doi.org/10.1038/n1" } },
          ],
        });
      },
    });
    const paper = "https://arxiv.org/html/2210.03629";
    expect(src.follows?.("refs", paper)).toBe(true);
    expect(src.follows?.("citers", "https://arxiv.org/abs/2210.03629v3")).toBe(true);
    expect(src.follows?.("posts", paper)).toBe(false);
    expect(src.follows?.("refs", "https://example.com/a")).toBe(false);

    // What the paper leans on first, then most cited; the arXiv page when it has one, else the DOI.
    const refs = await src.follow?.("refs", paper, 5);
    expect(refs?.[0]).toEqual({
      url: "https://www.semanticscholar.org/paper/abc",
      title: "WebShop",
      snippet: "The paper leans on it. Cited 40 times (Semantic Scholar).",
    });
    expect(refs?.slice(1)).toEqual([
      {
        url: "https://arxiv.org/abs/2201.11903",
        title: "Chain of thought",
        channel: "Jason Wei",
        date: "2022",
        snippet: "Cited 900 times (Semantic Scholar). Abstract: Prompting with steps.",
      },
      {
        url: "https://doi.org/10.1/r",
        title: "Rare",
        snippet: "Cited 3 times (Semantic Scholar).",
      },
    ]);
    expect(asked[0]).toContain("/paper/arXiv:2210.03629/references?");

    expect(await src.follow?.("citers", paper, 5)).toEqual([
      {
        url: "https://arxiv.org/abs/2309.07864",
        title: "Agents survey",
        channel: "Zhiheng Xi",
        date: "2025-01-17",
        snippet: "Cited 965 times (OpenAlex). Abstract: Agents act",
      },
      { url: "https://doi.org/10.1038/n1", title: "No arXiv copy" },
    ]);
    // The work is the row naming the id, never a longer one.
    const cites = new URL(asked.at(-1) as string).searchParams;
    expect(cites.get("filter")).toBe("cites:W1");
    expect(cites.get("sort")).toBe("cited_by_count:desc");
    expect(cites.get("per_page")).toBe("5");
  });

  it("throws on a refused follow: a spent budget is a gap, not an empty list", async () => {
    const src = arxivSource({
      agent: "birdwatch test",
      gapMs: 0,
      fetchFn: async () => new Response("slow down", { status: 429 }),
    });
    await expect(src.follow?.("refs", "https://arxiv.org/abs/2210.03629", 5)).rejects.toThrow(
      "semanticscholar: HTTP 429",
    );
    await expect(src.follow?.("citers", "https://arxiv.org/abs/2210.03629", 5)).rejects.toThrow(
      "openalex: HTTP 429",
    );
  });

  const entry = (id: string, title: string, comment?: string) => `<entry>
    <id>http://arxiv.org/abs/${id}v2</id>
    <title>${title}
      on two lines</title>
    <summary>We report a 12% gain.</summary>
    <published>2025-02-12T16:39:06Z</published>
    ${comment ? `<arxiv:comment>${comment}</arxiv:comment>` : ""}
    <author><name>Ann</name></author><author><name>Bo</name></author>
    <author><name>Cy</name></author><author><name>Di</name></author>
  </entry>`;
  const feed = (total: number, entries: string[]) =>
    `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><opensearch:totalResults>${total}</opensearch:totalResults>${entries.join("")}</feed>`;
  const page = `<html><head><title>A paper</title></head><body><main><h1>A paper</h1><p>${"word ".repeat(80)}</p></main></body></html>`;

  it("asks every word inside the categories, then tops up with any word", async () => {
    expect(arxivQuery("How do multi-agent planners improve?", ["cs.AI", "cs.MA"])).toBe(
      '(all:"multi-agent" AND all:"planners" AND all:"improve") AND (cat:cs.AI OR cat:cs.MA)',
    );
    expect(arxivQuery("agent planning", [], true)).toBe('all:"agent" OR all:"planning"');
    expect(() => arxivQuery("how do")).toThrow("no words");
    const asked: string[] = [];
    const src = arxivSource({
      agent: "birdwatch test",
      categories: ["cs.AI"],
      gapMs: 0,
      fetchFn: async (input, init) => {
        const url = String(input);
        asked.push(
          url.startsWith("https://export.arxiv.org")
            ? (new URL(url).searchParams.get("search_query") ?? url)
            : url,
        );
        if (url.includes("openalex"))
          return json({
            results: [
              {
                ids: { doi: "https://doi.org/10.18653/v1/2025.acl-main.1" },
                cited_by_count: 120,
                locations: [{ landing_page_url: "https://arxiv.org/abs/2502.08557v2" }],
              },
            ],
          });
        expect(new Headers(init?.headers).get("user-agent")).toBe("birdwatch test");
        return new Response(
          url.includes("+AND+all") || url.includes("%20AND%20all")
            ? feed(0, [])
            : feed(2, [
                entry("2502.08557", "Agent planning", "ACL 2025. Code: https://github.com/x/y"),
                entry("2503.01763", "Tool use"),
              ]),
        );
      },
    });
    const hits = await src.search?.(query("agent planning"));
    expect(asked.length).toBe(3);
    expect(asked[1]).toBe('(all:"agent" OR all:"planning") AND (cat:cs.AI)');
    expect(hits?.[0]).toEqual({
      url: "https://arxiv.org/abs/2502.08557",
      title: "Agent planning on two lines",
      channel: "Ann, Bo, Cy et al.",
      date: "2025-02-12",
      snippet:
        "Cited 120 times (OpenAlex). Comment: ACL 2025. Code: https://github.com/x/y Abstract: We report a 12% gain.",
    });
    expect(hits?.[1]?.snippet).toBe("Abstract: We report a 12% gain.");
    expect(src.keeps?.("arxiv.org")).toBe(true);
    expect(src.keeps?.("reddit.com")).toBe(false);
  });

  it("reads the HTML page, the PDF when there is none; every form of a paper's URL is one", async () => {
    const asked: string[] = [];
    const src = arxivSource({
      agent: "birdwatch test",
      gapMs: 0,
      fetchFn: async (input) => {
        const url = String(input);
        asked.push(url);
        if (url.includes("/html/2210.03629"))
          return new Response(page, { headers: { "content-type": "text/html" } });
        return new Response("no", { status: 404, headers: { "content-type": "text/html" } });
      },
    });
    expect(src.opens?.("https://arxiv.org/pdf/2210.03629v3.pdf")).toBe(true);
    expect(src.opens?.("https://arxiv.org/list/cs.AI")).toBe(false);
    const doc = await src.open?.(hit("https://arxiv.org/pdf/2210.03629v3.pdf"));
    expect(doc?.url).toBe("https://arxiv.org/html/2210.03629");
    expect(doc?.text).toContain("word");
    expect(asked).toEqual(["https://export.arxiv.org/html/2210.03629"]);
    await expect(src.open?.(hit("https://arxiv.org/abs/1706.03762"))).rejects.toThrow(
      "arxiv: HTTP 404",
    );
    expect(asked.slice(1)).toEqual([
      "https://export.arxiv.org/html/1706.03762",
      "https://export.arxiv.org/pdf/1706.03762",
    ]);
    expect(canonical("https://export.arxiv.org/html/2210.03629v2/")).toBe(
      canonical("https://arxiv.org/pdf/2210.03629.pdf"),
    );
  });

  it("keeps arXiv's 3 seconds between calls, one at a time", async () => {
    const at: number[] = [];
    const src = arxivSource({
      agent: "birdwatch test",
      gapMs: 50,
      fetchFn: async () => {
        at.push(Date.now());
        return new Response(page, { headers: { "content-type": "text/html" } });
      },
    });
    await Promise.all([
      src.open?.(hit("https://arxiv.org/abs/2210.03629")),
      src.open?.(hit("https://arxiv.org/abs/2210.03630")),
    ]);
    expect((at[1] as number) - (at[0] as number)).toBeGreaterThanOrEqual(45);
  });
});

describe("ladder", () => {
  it("opens through the ladder and throws on a block", async () => {
    const fetched = (block: string | null): LadderClient => ({
      call: async <T>() =>
        ({
          finalUrl: "https://e.example/final",
          status: 200,
          html: `<html><head><title>E</title></head><body><p>ladder text here for the page ${"word ".repeat(50)}</p></body></html>`,
          tier: "render",
          block,
          tries: [],
        }) as T,
    });
    const ok = await ladderSource({ sites: fetched(null) }).open?.(hit("https://e.example"));
    expect(ok?.url).toBe("https://e.example/final");
    expect(ok?.text).toContain("ladder text");
    // A block is a miss, like the fetcher's 403: the read step writes a gap and goes on.
    await expect(
      ladderSource({ sites: fetched("captcha") }).open?.(hit("https://e.example")),
    ).rejects.toThrow("ladder: captcha at render");
    const pdf: LadderClient = {
      call: async <T>() =>
        ({
          finalUrl: "https://e.example/a.pdf",
          status: 200,
          html: "%PDF",
          type: "application/pdf",
          tier: "render",
          block: null,
          tries: [],
        }) as T,
    };
    await expect(
      ladderSource({ sites: pdf }).open?.(hit("https://e.example/a.pdf")),
    ).rejects.toThrow("ladder: application/pdf is not html");
    expect(ladderSource({ sites: pdf }).opens?.("https://youtu.be/abc123def45")).toBe(false);
  });
  it("a wall, a 404 shell or an empty body is a miss with a reason, never a document", async () => {
    const page = (html: string, status = 200): LadderClient => ({
      call: async <T>() =>
        ({
          finalUrl: "https://e.example",
          status,
          html,
          tier: "render",
          block: null,
          tries: [],
        }) as T,
    });
    const url = hit("https://e.example");
    const wall = `<html><head><title>Reddit - Prove your humanity</title></head><body><p>${"word ".repeat(60)}</p></body></html>`;
    await expect(ladderSource({ sites: page(wall) }).open?.(url)).rejects.toThrow(
      'ladder: a wall, not a page: "Reddit - Prove your humanity" at render',
    );
    await expect(
      ladderSource({ sites: page("<html><body><p>thin</p></body></html>") }).open?.(url),
    ).rejects.toThrow("ladder: only 4 characters of text, no page at render");
    await expect(ladderSource({ sites: page(wall, 404) }).open?.(url)).rejects.toThrow(
      "ladder: HTTP 404 at render",
    );
    // The fetcher asks the same question of a 200.
    const shell = {
      open: async () =>
        new Response(
          `<html><head><title>Page Not Found | Framer</title></head><body><p>${"word ".repeat(60)}</p></body></html>`,
          {
            status: 200,
            headers: { "content-type": "text/html" },
          },
        ),
    };
    await expect(fetcherSource({ fetcher: shell }).open?.(url)).rejects.toThrow(
      'fetcher: a wall, not a page: "Page Not Found | Framer"',
    );
  });
  it("speaks the Restate ingress: POST $service/call with the site call, a bearer, Restate's message", async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const sites = ingressLadderClient({
      url: "https://ingress.local/",
      token: "t",
      caller: "birdwatch:test",
      fetchFn: async (u, init) => {
        seen.push({ url: String(u), init });
        return seen.length === 1
          ? json({ finalUrl: "https://e.example" })
          : json({ code: 429, message: "fetch: 1500 of 1500 today" }, 429);
      },
    });
    expect(
      await sites.call("web", "GET", "/fetch", { url: "https://e.example", from: "impersonate" }),
    ).toEqual({ finalUrl: "https://e.example" });
    expect(seen[0]?.url).toBe("https://ingress.local/desk/call");
    const h = new Headers(seen[0]?.init?.headers);
    expect(h.get("authorization")).toBe("Bearer t");
    expect(h.get("idempotency-key")).toMatch(/[0-9a-f-]{36}/);
    expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({
      site: "web",
      method: "GET",
      path: "/fetch",
      input: { url: "https://e.example", from: "impersonate" },
      caller: "birdwatch:test",
    });
    const err = await sites.call("web", "GET", "/fetch", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LadderCallError);
    expect((err as LadderCallError).status).toBe(429);
    expect((err as Error).message).toContain("429 fetch: 1500 of 1500 today");
  });
  it("speaks autobrowse's wire: GET with a query, a bearer token, errors by status", async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const sites = httpLadderClient({
      url: "http://desk.local/",
      token: "t",
      fetchFn: async (u, init) => {
        seen.push({ url: String(u), init });
        return seen.length === 1 ? json({ ok: 1 }) : json({ error: "offline" }, 503);
      },
    });
    expect(
      await sites.call("web", "GET", "/fetch", { url: "https://e.example", from: "impersonate" }),
    ).toEqual({ ok: 1 });
    expect(seen[0]?.url).toBe(
      "http://desk.local/api/sites/web/fetch?url=https%3A%2F%2Fe.example&from=impersonate",
    );
    expect(new Headers(seen[0]?.init?.headers).get("authorization")).toBe("Bearer t");
    await expect(sites.call("web", "GET", "/fetch", {})).rejects.toThrow("503 offline");
  });
});

describe("youtube", () => {
  it("lists a search as hits and reads a video as a document", async () => {
    const src = ytdlpSource({
      ytDlp: "yt-dlp",
      list: async (_cmd, target) => {
        expect(target).toBe("ytsearch2:cold email");
        return [
          {
            id: "abc123def45",
            title: "T",
            channel: "Ch",
            duration: 61.4,
            timestamp: 1767225600,
            description: "d",
          },
          { url: "https://other.example/v" },
        ];
      },
      read: async (url) => ({
        kind: "youtube",
        id: "abc123def45",
        title: "T",
        url,
        channel: "Ch",
        uploaded: "2026-01-01",
        duration: 61,
        body: "the transcript",
      }),
      n: 2,
    });
    expect(await src.search?.(query("cold email"))).toEqual([
      {
        url: "https://www.youtube.com/watch?v=abc123def45",
        title: "T",
        channel: "Ch",
        length: 61,
        date: "2026-01-01",
        snippet: "d",
      },
      { url: "https://other.example/v" },
    ]);
    const doc = await src.open?.(hit("https://youtu.be/abc123def45"));
    expect(doc).toEqual({
      url: "https://youtu.be/abc123def45",
      media: "video",
      title: "T",
      text: "the transcript",
      channel: "Ch",
      date: "2026-01-01",
      length: 61,
    });
    expect(src.opens?.("https://other.example/v")).toBe(false);
    expect(src.opens?.("https://youtu.be/abc123def45")).toBe(true);
    await expect(src.open?.(hit("https://other.example/v"))).rejects.toThrow("not a YouTube page");
    expect(entryHit({})).toBeNull();
  });

  it("follows a video to its channel's uploads; a TikTok profile to its posts", async () => {
    expect(postsOf("https://www.youtube.com/@bee")).toEqual({
      target: "https://www.youtube.com/@bee/videos",
      site: "youtube",
    });
    expect(postsOf("https://youtube.com/channel/UC1/featured")).toEqual({
      target: "https://www.youtube.com/channel/UC1/videos",
      site: "youtube",
    });
    expect(postsOf("https://youtu.be/abc123def45")).toBe("video");
    expect(postsOf("https://www.tiktok.com/@bee/video/1")).toEqual({
      target: "https://www.tiktok.com/@bee",
      site: "other",
    });
    expect(postsOf("https://www.youtube.com/results?q=x")).toBeNull();
    expect(postsOf("https://other.example/@bee")).toBeNull();

    const listed: unknown[] = [];
    const src = ytdlpSource({
      ytDlp: "yt-dlp",
      info: async () => ({ channel_url: "https://www.youtube.com/channel/UC1" }),
      list: async (_cmd, target, range) => {
        listed.push({ target, range });
        return target.includes("tiktok")
          ? [{ url: "https://www.tiktok.com/@bee/video/2", title: "tt" }]
          : [{ id: "xyz123def45", title: "next", channel: "Bee" }];
      },
      read: async () => {
        throw new Error("unused");
      },
    });
    expect(src.follows?.("posts", "https://youtu.be/abc123def45")).toBe(true);
    expect(src.follows?.("similar", "https://youtu.be/abc123def45")).toBe(false);
    expect(await src.follow?.("posts", "https://youtu.be/abc123def45", 3)).toEqual([
      { url: "https://www.youtube.com/watch?v=xyz123def45", title: "next", channel: "Bee" },
    ]);
    expect(await src.follow?.("posts", "https://www.tiktok.com/@bee", 3)).toEqual([
      { url: "https://www.tiktok.com/@bee/video/2", title: "tt" },
    ]);
    expect(listed).toEqual([
      { target: "https://www.youtube.com/channel/UC1/videos", range: { start: 1, end: 3 } },
      { target: "https://www.tiktok.com/@bee", range: { start: 1, end: 3 } },
    ]);
  });
});

describe("paste and ledger", () => {
  it("a paste answers once, marked human", async () => {
    const src = paste([{ url: "https://p.example", title: "P" }], "will");
    expect(src.from).toBe("human");
    expect(src.by).toBe("will");
    expect(await src.search?.(query("anything"))).toEqual([
      { url: "https://p.example", title: "P" },
    ]);
    expect(await src.search?.(query("more"))).toEqual([]);
  });
  it("the ledger answers from other runs' hits that hold every word", async () => {
    const ledger = new MemoryLedger();
    await ledger.append(
      hit("https://l.example/1", { run: "run-b", key: "k1", title: "Staffing margins fall" }),
    );
    await ledger.append(
      hit("https://l.example/1", {
        run: "run-c",
        id: "r-2",
        key: "k1",
        title: "Staffing margins fall",
      }),
    );
    await ledger.append(
      hit("https://l.example/2", { run: "run-b", id: "r-3", key: "k2", snippet: "margins" }),
    );
    await ledger.append(
      hit("https://l.example/3", { run: "run-a", id: "r-4", key: "k3", title: "staffing margins" }),
    );
    const hits = await ledgerSource(ledger).search?.(query("Staffing MARGINS"));
    expect(hits).toEqual([{ url: "https://l.example/1", title: "Staffing margins fall" }]);
  });
});
