import { describe, expect, it } from "vitest";
import { FetchError, type Fetcher, type FetchResponse } from "./fetcher.js";
import { canFetch, type RobotsCache, RobotsPolicy, robotsFor } from "./robots.js";

class Canned implements Fetcher {
  readonly userAgent = "weaver/0.1 (test@example.com)";
  readonly requested: string[] = [];
  constructor(private readonly pages: Record<string, string | FetchError>) {}
  async get(url: string): Promise<FetchResponse> {
    this.requested.push(url);
    const body = this.pages[url];
    if (body instanceof FetchError) throw body;
    return { status: body === undefined ? 404 : 200, url, text: body ?? "" };
  }
}

describe("RobotsPolicy", () => {
  it("longest matching rule wins (RFC 9309), star group is the fallback", () => {
    const p = RobotsPolicy.parse(
      "User-agent: *\nDisallow: /private\nAllow: /private/ok\n\nUser-agent: weaver\nDisallow: /weaver-only\n",
    );
    expect(p.canFetch("weaver/0.1 (x)", "https://h/weaver-only/x")).toBe(false);
    expect(p.canFetch("weaver/0.1 (x)", "https://h/private")).toBe(true);
    expect(p.canFetch("other/1", "https://h/private/ok")).toBe(true);
    expect(p.canFetch("other/1", "https://h/private/no")).toBe(false);
    expect(p.canFetch("other/1", "https://h/public")).toBe(true);
  });

  it("reads * and $ in paths", () => {
    const p = RobotsPolicy.parse("User-agent: *\nDisallow: /*.pdf$\nDisallow: /*?sort=\n");
    expect(p.canFetch("weaver/0.1", "https://h/files/a.pdf")).toBe(false);
    expect(p.canFetch("weaver/0.1", "https://h/files/a.pdf.html")).toBe(true);
    expect(p.canFetch("weaver/0.1", "https://h/list?sort=asc")).toBe(false);
    expect(p.canFetch("weaver/0.1", "https://h/list")).toBe(true);
  });

  it("merges groups that name the same agent", () => {
    const p = RobotsPolicy.parse(
      "User-agent: weaver\nDisallow: /a\n\nUser-agent: weaver\nDisallow: /b\n",
    );
    expect(p.canFetch("weaver/0.1", "https://h/a")).toBe(false);
    expect(p.canFetch("weaver/0.1", "https://h/b")).toBe(false);
  });

  it("empty Disallow allows everything; comments ignored", () => {
    const p = RobotsPolicy.parse("# hi\nUser-agent: *\nDisallow: # nothing\n");
    expect(p.canFetch("weaver/0.1", "https://h/anything")).toBe(true);
  });

  it("disallow all", () => {
    const p = RobotsPolicy.parse("User-agent: *\nDisallow: /\n");
    expect(p.canFetch("weaver/0.1", "https://h/")).toBe(false);
    expect(p.canFetch("weaver/0.1", "https://h")).toBe(false);
    expect(RobotsPolicy.disallowAll().canFetch("weaver/0.1", "https://h/")).toBe(false);
    expect(RobotsPolicy.allowAll().canFetch("weaver/0.1", "https://h/")).toBe(true);
  });
});

describe("robotsFor", () => {
  it("caches per scheme+host and treats 4xx as allow", async () => {
    const f = new Canned({ "https://a.example/robots.txt": "User-agent: *\nDisallow: /" });
    const cache: RobotsCache = new Map();
    expect(await canFetch(f, "https://a.example/x", cache)).toBe(false);
    expect(await canFetch(f, "https://a.example/y", cache)).toBe(false);
    expect(await canFetch(f, "http://a.example/x", cache)).toBe(true); // other scheme: own file (404 -> allow)
    expect(await canFetch(f, "https://www.a.example/x", cache)).toBe(true);
    expect(f.requested.filter((u) => u.endsWith("/robots.txt"))).toHaveLength(3);
  });

  it("5xx means disallow-all, unreachable means allow", async () => {
    const f = new Canned({
      "https://down.example/robots.txt": new FetchError("GET failed", 503),
      "https://dead.example/robots.txt": new FetchError("GET failed", null),
    });
    const cache: RobotsCache = new Map();
    expect(
      (await robotsFor(f, "https://down.example/p", cache)).canFetch(
        f.userAgent,
        "https://down.example/p",
      ),
    ).toBe(false);
    expect(await canFetch(f, "https://dead.example/p", cache)).toBe(true);
  });
});
