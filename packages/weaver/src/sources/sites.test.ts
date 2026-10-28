import { Transient } from "@wrenautomation/models";
import { describe, expect, it } from "vitest";
import type { LadderClient } from "../fetch/ladder.js";
import type { HitRecord } from "../ledger/records.js";
import {
  accountsFrom,
  facebookPost,
  facebookSource,
  httpLadderClient,
  ingressLadderClient,
  LadderCallError,
  redditSource,
  redditThread,
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

  it("puts the account on both wires", async () => {
    const seen: { url: string; body?: string }[] = [];
    const fetchFn = async (u: unknown, init?: RequestInit) => {
      seen.push({ url: String(u), ...(init?.body ? { body: String(init.body) } : {}) });
      return new Response("{}", { status: 200 });
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
    expect(JSON.parse(seen[1]?.body ?? "{}")).toMatchObject({
      site: "reddit",
      account: "reddit@alt",
    });
    await ingressLadderClient({ url: "https://ingress.local", fetchFn }).call(
      "web",
      "GET",
      "/fetch",
    );
    expect(JSON.parse(seen[2]?.body ?? "{}")).not.toHaveProperty("account");
  });
});
