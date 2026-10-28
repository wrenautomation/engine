import { describe, expect, it } from "vitest";
import type { LadderClient } from "../fetch/ladder.js";
import { MemoryLedger } from "../ledger/memory.js";
import type { HitRecord, QueryRecord } from "../ledger/records.js";
import {
  entryHit,
  exa,
  fetcherSource,
  httpLadderClient,
  ingressLadderClient,
  LadderCallError,
  ladderSource,
  ledgerSource,
  paste,
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
      caller: "weaver:test",
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
      caller: "weaver:test",
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
