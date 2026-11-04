import { Transient } from "@wrenautomation/models";
import type { LadderClient } from "@wrenautomation/read/fetch";
import { describe, expect, it } from "vitest";
import type { Source } from "../engine/ports.js";
import { searchersFor } from "../engine/ports.js";
import type { HitRecord, QueryRecord } from "../ledger/records.js";
import {
  accountsFrom,
  facebookPost,
  facebookSource,
  httpLadderClient,
  ingressLadderClient,
  LadderCallError,
  linkedinSource,
  redditSource,
  redditThread,
  redditUser,
} from "./index.js";

const hit = (url: string): HitRecord => ({
  id: "h-1",
  run: "run-a",
  round: 1,
  at: "2026-10-28T00:00:00.000Z",
  from: "ai",
  by: "m",
  type: "hit",
  url,
  key: url,
  sources: ["x"],
  queries: [],
});

interface Call {
  site: string;
  path: string;
  input: unknown;
  account?: string;
}
/** A worker that answers each site from `by`; a function throws or answers per call. */
const worker = (by: Record<string, unknown | ((c: Call) => unknown)>) => {
  const calls: Call[] = [];
  const sites: LadderClient = {
    async call<T>(
      site: string,
      _m: string,
      path: string,
      input?: unknown,
      o?: { account?: string },
    ) {
      const c: Call = { site, path, input, ...(o?.account ? { account: o.account } : {}) };
      calls.push(c);
      const a = by[site];
      return (typeof a === "function" ? a(c) : a) as T;
    },
  };
  return { sites, calls };
};

const words = (n: number) => "word ".repeat(n).trim();
const thread = [
  {
    kind: "Listing",
    data: {
      children: [
        {
          kind: "t3",
          data: {
            title: "Which CRM do you use?",
            subreddit: "smallbusiness",
            author: "op",
            score: 42,
            num_comments: 2,
            selftext: words(60),
            is_self: true,
            created_utc: 1_761_609_600,
          },
        },
      ],
    },
  },
  {
    kind: "Listing",
    data: {
      children: [
        { kind: "t1", data: { author: "a", score: 9, body: "HubSpot, the free tier." } },
        { kind: "t1", data: { author: "b", body: "" } },
        { kind: "more", data: {} },
      ],
    },
  },
];

describe("site readers", () => {
  it("reads the accounts spec and claims only their own URLs", () => {
    expect([...accountsFrom(" reddit=reddit@alt , bad, x= ,linkedin=linkedin@wren")]).toEqual([
      ["reddit", "reddit@alt"],
      ["linkedin", "linkedin@wren"],
    ]);
    expect(accountsFrom(undefined).size).toBe(0);
    expect(redditThread("https://www.reddit.com/r/sb/comments/1abc2d/which_crm/")).toEqual({
      article: "1abc2d",
    });
    expect(redditThread("https://old.reddit.com/r/sb/comments/1ABC2D/which_crm/kx9z1/")).toEqual({
      article: "1abc2d",
      comment: "kx9z1",
    });
    expect(redditThread("https://redd.it/1abc2d")).toEqual({ article: "1abc2d" });
    expect(redditThread("https://www.reddit.com/r/sb/")).toBeNull();
    expect(redditThread("https://notreddit.com/comments/1abc2d")).toBeNull();
    expect(facebookPost("https://www.facebook.com/groups/smb.owners/posts/1234567890/")).toEqual({
      group: "smb.owners",
      post: "1234567890",
    });
    expect(facebookPost("https://m.facebook.com/groups/123456/permalink/98765432/")).toEqual({
      group: "123456",
      post: "98765432",
    });
    expect(facebookPost("https://www.facebook.com/somepage/posts/1234567890")).toBeNull();
    expect(redditSource({ sites: worker({}).sites }).first).toBe(true);
  });

  it("reads a thread signed out as the post, then each comment with words", async () => {
    const w = worker({ "reddit-public": thread });
    const doc = await redditSource({ sites: w.sites }).open?.(
      hit("https://www.reddit.com/r/smallbusiness/comments/1abc2d/which_crm/"),
    );
    expect(w.calls).toEqual([
      {
        site: "reddit-public",
        path: "/comments/1abc2d",
        input: { article: "1abc2d", limit: 200, sort: "top" },
      },
    ]);
    expect(doc).toMatchObject({
      media: "text",
      title: "Which CRM do you use?",
      channel: "r/smallbusiness",
      date: "2025-10-28",
    });
    expect(doc?.text).toContain("r/smallbusiness · u/op · 42 points · 2 comments");
    expect(doc?.text).toContain("Comments:\n\nu/a (9): HubSpot, the free tier.");
    expect(doc?.text).not.toContain("u/b");
  });

  it("asks a permalink's comment with context", async () => {
    const w = worker({ "reddit-public": thread });
    await redditSource({ sites: w.sites }).open?.(
      hit("https://www.reddit.com/r/sb/comments/1abc2d/x/kx9z1/"),
    );
    expect(w.calls[0]?.input).toEqual({
      article: "1abc2d",
      limit: 200,
      sort: "top",
      comment: "kx9z1",
      context: 3,
    });
  });

  it("signs in as the named account only after the signed-out read missed", async () => {
    const refused = () => {
      throw new LadderCallError("reddit-public GET /comments/1abc2d: 500 HTTP 403", 500);
    };
    const w = worker({ "reddit-public": refused, reddit: thread });
    const doc = await redditSource({ sites: w.sites, account: "reddit@alt" }).open?.(
      hit("https://redd.it/1abc2d"),
    );
    expect(doc?.title).toBe("Which CRM do you use?");
    expect(w.calls.map((c) => [c.site, c.account])).toEqual([
      ["reddit-public", undefined],
      ["reddit", "reddit@alt"],
    ]);
    // With no account named, the miss stays a miss: nothing reads signed in.
    const alone = worker({ "reddit-public": refused, reddit: thread });
    await expect(
      redditSource({ sites: alone.sites }).open?.(hit("https://redd.it/1abc2d")),
    ).rejects.toThrow("reddit signed out: reddit-public GET /comments/1abc2d: 500 HTTP 403");
    expect(alone.calls).toHaveLength(1);
    // Not there signed out: not there signed in either, so no second read.
    const gone = worker({
      "reddit-public": { error: 404, message: "no such thing" },
      reddit: thread,
    });
    await expect(
      redditSource({ sites: gone.sites, account: "reddit@alt" }).open?.(
        hit("https://redd.it/1abc2d"),
      ),
    ).rejects.toThrow("reddit: no such thing");
    expect(gone.calls).toHaveLength(1);
    // Both missed: both reasons.
    const both = worker({
      "reddit-public": refused,
      reddit: { error: 404, message: "no such thing" },
    });
    await expect(
      redditSource({ sites: both.sites, account: "reddit@alt" }).open?.(
        hit("https://redd.it/1abc2d"),
      ),
    ).rejects.toThrow(/reddit signed out: .*403; reddit: no such thing/);
  });

  it("signs in on a wall, never on a spent cap or a broken site", async () => {
    const coded = (code: string, status: number) => () => {
      throw new LadderCallError(`reddit-public GET /comments/1abc2d: ${status} no`, status, code);
    };
    const tried = async (by: () => never) => {
      const w = worker({ "reddit-public": by, reddit: thread });
      await redditSource({ sites: w.sites, account: "reddit@alt" })
        .open?.(hit("https://redd.it/1abc2d"))
        .catch(() => null);
      return w.calls.map((c) => c.site);
    };
    expect(await tried(coded("need_login", 401))).toEqual(["reddit-public", "reddit"]);
    expect(await tried(coded("platform_blocked", 403))).toEqual(["reddit-public", "reddit"]);
    expect(await tried(coded("rate_limited", 429))).toEqual(["reddit-public"]);
    expect(await tried(coded("upstream_broken", 502))).toEqual(["reddit-public"]);
    // The code is in the reason the agent reads.
    await expect(
      redditSource({
        sites: worker({ "reddit-public": coded("upstream_broken", 502) }).sites,
      }).open?.(hit("https://redd.it/1abc2d")),
    ).rejects.toThrow("reddit signed out: upstream_broken: reddit-public GET");
  });

  it("reads the access code off both wires", async () => {
    const answer = (body: unknown, status: number) => async () =>
      new Response(JSON.stringify(body), { status });
    const http = httpLadderClient({
      url: "http://desk.local",
      fetchFn: answer({ error: "signed out", code: "need_login" }, 401),
    });
    await expect(http.call("reddit", "GET", "/comments/1")).rejects.toMatchObject({
      status: 401,
      code: "need_login",
    });
    const ingress = ingressLadderClient({
      url: "https://ingress.local",
      fetchFn: answer(
        { code: 403, message: "captcha", metadata: { code: "platform_blocked" } },
        403,
      ),
    });
    await expect(ingress.call("reddit", "GET", "/comments/1")).rejects.toMatchObject({
      status: 403,
      code: "platform_blocked",
    });
    const old = ingressLadderClient({
      url: "https://ingress.local",
      fetchFn: answer({ code: 404, message: "no site" }, 404),
    });
    await expect(old.call("x", "GET", "/y")).rejects.toMatchObject({ status: 404, code: null });
  });

  it("sorts a worker's no: a spent cap and a 404 miss; a busy profile and no answer retry", async () => {
    const throws = (e: unknown) => () => {
      throw e;
    };
    const open = (by: unknown) =>
      redditSource({ sites: worker({ "reddit-public": by }).sites }).open?.(
        hit("https://redd.it/1abc2d"),
      );
    await expect(open(throws(new LadderCallError("cap", 429)))).rejects.toThrow(
      "reddit signed out: reddit-public's cap is spent for today",
    );
    await expect(open({ error: 404, message: "no such thing: /comments/1abc2d" })).rejects.toThrow(
      "reddit: no such thing: /comments/1abc2d",
    );
    await expect(open(throws(new LadderCallError("not sent: busy", 503)))).rejects.toBeInstanceOf(
      Transient,
    );
    await expect(open(throws(new TypeError("fetch failed")))).rejects.toBeInstanceOf(Transient);
    // A Transient signed out is no reason to sign in.
    const w = worker({ "reddit-public": throws(new TypeError("fetch failed")), reddit: thread });
    await expect(
      redditSource({ sites: w.sites, account: "reddit@alt" }).open?.(hit("https://redd.it/1abc2d")),
    ).rejects.toBeInstanceOf(Transient);
    expect(w.calls).toHaveLength(1);
  });

  it("reads a group post signed out, its whole text then the comments", async () => {
    const w = worker({
      "fb-public": {
        post: { author: "Dana", badge: "Admin", time: "2h", all: words(50), text: "short" },
        comments: [
          { author: "Lee", text: "We use Jobber." },
          { author: "Sam", text: "" },
        ],
      },
    });
    const doc = await facebookSource({ sites: w.sites }).open?.(
      hit("https://www.facebook.com/groups/smb.owners/posts/1234567890/"),
    );
    expect(w.calls).toEqual([
      {
        site: "fb-public",
        path: "/groups/smb.owners/posts/1234567890",
        input: { group: "smb.owners", post: "1234567890" },
      },
    ]);
    expect(doc?.text.startsWith(`Dana · Admin · 2h\n\n${words(50)}`)).toBe(true);
    expect(doc?.text).toContain("Comments:\n\nLee: We use Jobber.");
    expect(doc?.text).not.toContain("Sam");
    await expect(
      facebookSource({ sites: worker({ "fb-public": { post: null } }).sites }).open?.(
        hit("https://www.facebook.com/groups/g1/posts/1234567890"),
      ),
    ).rejects.toThrow("facebook: the walk read no post");
    // A thin post is junk, a miss.
    await expect(
      facebookSource({ sites: worker({ "fb-public": { post: { text: "hi" } } }).sites }).open?.(
        hit("https://www.facebook.com/groups/g1/posts/1234567890"),
      ),
    ).rejects.toThrow(/^facebook: /);
  });

  it("follows a Reddit user to their top posts and comments, one read of the cap", async () => {
    expect(redditUser("https://www.reddit.com/user/Bee_1/comments")).toBe("Bee_1");
    expect(redditUser("https://old.reddit.com/u/bee")).toBe("bee");
    expect(redditUser("https://www.reddit.com/r/x")).toBeNull();
    expect(redditUser("https://example.com/user/bee")).toBeNull();
    const { sites, calls } = worker({
      "reddit-public": {
        kind: "Listing",
        data: {
          children: [
            {
              kind: "t3",
              data: {
                permalink: "/r/sales/comments/1/a/",
                title: "How I keep clients",
                subreddit: "sales",
                selftext: "Weekly calls.",
                created_utc: 1_761_609_600,
              },
            },
            {
              kind: "t1",
              data: {
                permalink: "/r/sales/comments/1/a/c2/",
                link_title: "Q",
                subreddit: "sales",
                body: "Same here.",
              },
            },
            { kind: "t1", data: { body: "no link" } },
          ],
        },
      },
    });
    const src = redditSource({ sites });
    expect(src.follows?.("posts", "https://www.reddit.com/user/bee")).toBe(true);
    expect(src.follows?.("posts", "https://www.reddit.com/r/sales")).toBe(false);
    expect(await src.follow?.("posts", "https://www.reddit.com/user/bee", 300)).toEqual([
      {
        url: "https://www.reddit.com/r/sales/comments/1/a/",
        title: "How I keep clients",
        channel: "r/sales",
        date: "2025-10-28",
        snippet: "Weekly calls.",
      },
      {
        url: "https://www.reddit.com/r/sales/comments/1/a/c2/",
        title: "Q",
        channel: "r/sales",
        snippet: "Same here.",
      },
    ]);
    expect(calls).toEqual([
      {
        site: "reddit-public",
        path: "/user/bee/overview",
        input: { username: "bee", limit: 100, sort: "top" },
      },
    ]);
  });

  it("puts the account on both wires", async () => {
    const seen: { url: string; body?: string }[] = [];
    const fetchFn = async (u: unknown, init?: RequestInit) => {
      seen.push({ url: String(u), ...(init?.body ? { body: String(init.body) } : {}) });
      // the ingress: a send names the invocation, its output is the answer
      return new Response(String(u).endsWith("/send") ? '{"invocationId":"inv_1"}' : "{}", {
        status: 200,
      });
    };
    await httpLadderClient({ url: "http://desk.local", fetchFn }).call(
      "reddit",
      "GET",
      "/comments/1abc2d",
      { article: "1abc2d" },
      { account: "reddit@alt" },
    );
    expect(seen[0]?.url).toBe(
      "http://desk.local/api/sites/reddit/comments/1abc2d?article=1abc2d&account=reddit%40alt",
    );
    await ingressLadderClient({ url: "https://ingress.local", fetchFn }).call(
      "reddit",
      "GET",
      "/comments/1abc2d",
      {},
      { account: "reddit@alt" },
    );
    const sent = () => seen.filter((c) => c.body);
    expect(JSON.parse(sent()[0]?.body ?? "{}")).toMatchObject({
      site: "reddit",
      account: "reddit@alt",
    });
    await ingressLadderClient({ url: "https://ingress.local", fetchFn }).call(
      "web",
      "GET",
      "/fetch",
    );
    expect(JSON.parse(sent()[1]?.body ?? "{}")).not.toHaveProperty("account");
  });
});

describe("reddit search", () => {
  it("searches signed out, only on a query pinned to reddit.com", async () => {
    const w = worker({
      "reddit-public": {
        data: {
          children: [
            {
              kind: "t3",
              data: {
                permalink: "/r/startups/comments/1ab/first_sales_hire/",
                title: "First sales hire",
                subreddit: "startups",
                selftext: "It took 7 months.",
                created_utc: 1767225600,
                score: 41,
                num_comments: 12,
              },
            },
          ],
        },
      },
    });
    const src = redditSource({ sites: w.sites });
    const q = { terms: "first sales hire", site: "reddit.com" } as QueryRecord;
    expect(await src.search?.(q)).toEqual([
      {
        url: "https://www.reddit.com/r/startups/comments/1ab/first_sales_hire/",
        title: "First sales hire",
        channel: "r/startups",
        date: "2026-01-01",
        snippet: "It took 7 months.",
        metrics: { likes: 41, comments: 12 },
      },
    ]);
    expect(w.calls).toEqual([
      {
        site: "reddit-public",
        path: "/search",
        input: { q: "first sales hire", limit: 25 },
      },
    ]);
    await src.search?.({ ...q, preset: "top-month" });
    expect(w.calls.at(-1)?.input).toEqual({
      q: "first sales hire",
      limit: 25,
      preset: "top-month",
    });
    const names = (site?: string) =>
      searchersFor([src, exaLike], site ? { site } : {}).map((s) => s.name);
    expect(names("www.reddit.com")).toEqual(["reddit"]);
    expect(names()).toEqual(["exa"]);
  });
});

describe("linkedin", () => {
  const posts = {
    posts: [
      {
        urn: "urn:li:activity:1",
        author: "Jane Doe",
        authorUrl: "https://www.linkedin.com/in/jane-doe/",
        text: " We hired two reps at once. ",
        at: "2026-10-20T08:00:00.000Z",
        reactions: 120,
        comments: 14,
        url: "https://www.linkedin.com/feed/update/urn:li:activity:1/",
      },
      {
        urn: "urn:li:activity:2",
        author: "Acme",
        authorUrl: null,
        text: "",
        reactions: 0,
        comments: 0,
        url: "https://www.linkedin.com/feed/update/urn:li:activity:2/",
      },
    ],
    dropped: 1,
  };
  it("searches posts as the named account, only on a query pinned to linkedin.com", async () => {
    const w = worker({ linkedin: posts });
    const src = linkedinSource({ sites: w.sites, account: "linkedin@wren" });
    const q = { terms: "first sales hire", site: "linkedin.com" } as QueryRecord;
    expect(await src.search?.(q)).toEqual([
      {
        url: "https://www.linkedin.com/feed/update/urn:li:activity:1/",
        channel: "in/jane-doe",
        date: "2026-10-20",
        snippet: "We hired two reps at once.",
        metrics: { likes: 120, comments: 14 },
      },
      {
        url: "https://www.linkedin.com/feed/update/urn:li:activity:2/",
        channel: "Acme",
        metrics: { likes: 0, comments: 0 },
      },
    ]);
    expect(w.calls).toEqual([
      {
        site: "linkedin",
        path: "/search/results/content",
        input: { keywords: "first sales hire", max: 100 },
        account: "linkedin@wren",
      },
    ]);
    // a preset goes to the route as is: autobrowse maps it to sortBy and datePosted
    await src.search?.({ ...q, preset: "latest-week" });
    expect(w.calls.at(-1)?.input).toEqual({
      keywords: "first sales hire",
      max: 100,
      preset: "latest-week",
    });
    expect(src.presets).toBe(true);
    const names = (site?: string) =>
      searchersFor([src, exaLike], site ? { site } : {}).map((s) => s.name);
    expect(names("www.linkedin.com")).toEqual(["linkedin"]);
    expect(names()).toEqual(["exa"]);
  });

  it("follows a member to their own posts and a Page to its posts", async () => {
    const w = worker({
      linkedin: (c: Call) =>
        c.path.endsWith("/activity")
          ? {
              activity: [
                {
                  kind: "post",
                  urn: "u:1",
                  text: "Mine",
                  reactions: 9,
                  comments: 1,
                  url: "https://www.linkedin.com/feed/update/u:1/",
                },
                {
                  kind: "repost",
                  urn: "u:2",
                  text: "Theirs",
                  reactions: 900,
                  comments: 50,
                  url: "https://www.linkedin.com/feed/update/u:2/",
                },
              ],
            }
          : posts,
    });
    const src = linkedinSource({ sites: w.sites, account: "linkedin@wren" });
    expect(src.follows?.("posts", "https://www.linkedin.com/in/Jane-Doe/")).toBe(true);
    expect(src.follows?.("posts", "https://www.linkedin.com/feed/update/u:1/")).toBe(false);
    expect(await src.follow?.("posts", "https://www.linkedin.com/in/Jane-Doe/", 30)).toEqual([
      {
        url: "https://www.linkedin.com/feed/update/u:1/",
        channel: "in/jane-doe",
        snippet: "Mine",
        metrics: { likes: 9, comments: 1 },
      },
    ]);
    const page = await src.follow?.("posts", "https://www.linkedin.com/company/acme/posts/", 80);
    expect(page?.map((h) => h.channel)).toEqual(["company/acme", "company/acme"]);
    expect(w.calls.map((c) => [c.path, c.input])).toEqual([
      ["/in/jane-doe/activity", { vanity: "jane-doe", max: 30 }],
      ["/company/acme/posts", { company: "acme", max: 80 }],
    ]);
  });
});

const exaLike = {
  name: "exa",
  kind: "search",
  cost: "metered",
  keeps: (site: string) => !/(^|\.)(reddit|linkedin)\.com$/i.test(site),
  search: async () => [],
} as Source;
