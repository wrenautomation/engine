/**
 * Readers for one site each, over that site's own read route on an autobrowse worker (the same
 * wire as the ladder). Each claims only its site's URLs and goes before the general openers
 * (`first`): the route answers the thread or the post as data, where a fetched page is a wall or a
 * JavaScript shell.
 *
 * `reddit`: a thread (`/comments/{id}`) through `reddit-public` (signed out, the RSS feed), then,
 * when the caller named an account (`BIRDWATCH_ACCOUNTS=reddit=reddit@alt`), through `reddit`
 * signed in as it. Signed out goes first: read volume on a signed-in account is what Reddit
 * flags. A follow from a user's page (`/user/{name}`) lists their top posts and comments in one
 * read (`/user/{name}/overview`), signed out. `facebook`: one public group post through `fb-public`, always signed out (Wren's Meta
 * login runs the ads). Design: autobrowse `designs/2026-10-28-signed-in-reads.md`.
 *
 * A route that answered no (a 404, a spent cap, a refusal) is a miss with its reason and the
 * worker's access code; a worker that did not answer, or a busy profile (503), is a Transient.
 * A signed-out miss reads signed in, except a spent cap or a broken site (`rate_limited`,
 * `upstream_broken`): signing in fixes neither.
 */

import { Transient } from "@wrenautomation/models";
import type { LadderClient } from "@wrenautomation/read/fetch";
import type { Document } from "../document/index.js";
import type { Source } from "../engine/ports.js";
import type { HitViewIn } from "../plan/index.js";
import { junkReason } from "./junk.js";
import { LadderCallError } from "./ladder.js";

/** `reddit=reddit@alt,linkedin=linkedin@wren`: the account each site reader signs in as. */
export function accountsFrom(spec: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const pair of (spec ?? "").split(",")) {
    const [site, account] = pair.split("=").map((s) => s.trim());
    if (site && account) out.set(site, account);
  }
  return out;
}

const hostOf = (url: string): URL | null => {
  try {
    return new URL(url);
  } catch {
    return null;
  }
};

/** A Reddit thread's id, and the comment's when the URL is one comment's permalink. */
export function redditThread(url: string): { article: string; comment?: string } | null {
  const u = hostOf(url);
  if (!u) return null;
  const host = u.hostname.toLowerCase();
  if (host === "redd.it") {
    const m = /^\/([a-z0-9]{1,12})\/?$/i.exec(u.pathname);
    return m?.[1] ? { article: m[1].toLowerCase() } : null;
  }
  if (host !== "reddit.com" && !host.endsWith(".reddit.com")) return null;
  // `/comments/{id}`, then the title's slug, then a comment's id: each after the id is optional.
  const m = /\/comments\/([a-z0-9]{1,12})(?:\/[^/]*(?:\/([a-z0-9]{1,12}))?)?\/?$/i.exec(u.pathname);
  if (!m?.[1]) return null;
  return { article: m[1].toLowerCase(), ...(m[2] ? { comment: m[2].toLowerCase() } : {}) };
}

/** A Reddit user's name from their page (`/user/{name}`, `/u/{name}`). */
export function redditUser(url: string): string | null {
  const u = hostOf(url);
  if (!u) return null;
  const host = u.hostname.toLowerCase();
  if (host !== "reddit.com" && !host.endsWith(".reddit.com")) return null;
  const m = /^\/(?:user|u)\/([A-Za-z0-9_-]{3,20})(?:\/|$)/.exec(u.pathname);
  return m?.[1] ?? null;
}

/** A user's overview (posts and comments mixed) as hits: each its permalink, title and words. */
export function userHits(body: unknown): HitViewIn[] {
  return things(body).flatMap((t) => {
    const link = str(t.permalink);
    if (!link) return [];
    const words = (str(t.selftext) || str(t.body)).trim();
    const title = str(t.title) || str(t.link_title);
    const created = typeof t.created_utc === "number" ? t.created_utc : null;
    return [
      {
        url: `https://www.reddit.com${link}`,
        ...(title ? { title } : {}),
        ...(str(t.subreddit) ? { channel: `r/${str(t.subreddit)}` } : {}),
        ...(created ? { date: new Date(created * 1000).toISOString().slice(0, 10) } : {}),
        ...(words ? { snippet: words.slice(0, 300) } : {}),
      },
    ];
  });
}

/** A Facebook group post's group and post ids. */
export function facebookPost(url: string): { group: string; post: string } | null {
  const u = hostOf(url);
  if (!u) return null;
  const host = u.hostname.toLowerCase();
  if (host !== "facebook.com" && !host.endsWith(".facebook.com")) return null;
  const m = /^\/groups\/([\w.-]{2,100})\/(?:posts|permalink)\/(\d{5,25})\/?$/.exec(u.pathname);
  return m?.[1] && m[2] ? { group: m[1], post: m[2] } : null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const things = (listing: unknown): Obj[] => {
  const data = isObj(listing) && isObj(listing.data) ? listing.data : {};
  const children = Array.isArray(data.children) ? data.children : [];
  return children.filter(isObj).map((c) => (isObj(c.data) ? c.data : {}));
};

/** Reddit says the thread is not there (404): no account would read it either. */
class Gone extends Error {}

/** The worker refused the call; `code` is its access code when it sent one. */
class Refused extends Error {
  constructor(
    message: string,
    readonly code: string | null,
  ) {
    super(message);
  }
}

/** Codes a signed-in read would not fix: a spent cap (it would spend the account instead) or a broken site. */
const NOT_FOR_SIGN_IN = new Set(["rate_limited", "upstream_broken"]);

/** A thread (`[post listing, comments listing]`) as text: the post, then each comment. */
export function threadDocument(url: string, body: unknown): Document {
  if (isObj(body) && "error" in body) {
    const said = `reddit: ${str(body.message) || `error ${String(body.error)}`}`;
    throw body.error === 404 ? new Gone(said) : new Error(said);
  }
  const [postListing, commentListing] = Array.isArray(body) ? body : [body, null];
  const post = things(postListing)[0];
  if (!post) throw new Error("reddit: the thread came back without its post");
  const head = [
    `r/${str(post.subreddit)} · u/${str(post.author)}`,
    typeof post.score === "number" ? `${post.score} points` : "",
    typeof post.num_comments === "number" ? `${post.num_comments} comments` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const selftext = str(post.selftext).trim();
  const link = post.is_self === false && str(post.url) ? `Link: ${str(post.url)}` : "";
  const comments = things(commentListing)
    .filter((c) => str(c.body).trim())
    .map((c) => {
      const score = typeof c.score === "number" ? ` (${c.score})` : "";
      return `u/${str(c.author) || "[deleted]"}${score}: ${str(c.body).trim()}`;
    });
  const text = [
    str(post.title),
    head,
    selftext || link,
    comments.length ? `Comments:\n\n${comments.join("\n\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const created = typeof post.created_utc === "number" ? post.created_utc : null;
  return {
    url,
    media: "text",
    ...(str(post.title) ? { title: str(post.title) } : {}),
    text,
    ...(str(post.subreddit) ? { channel: `r/${str(post.subreddit)}` } : {}),
    ...(created ? { date: new Date(created * 1000).toISOString().slice(0, 10) } : {}),
  };
}

const POST_KEYS = ["author", "badge", "time", "title"] as const;

/** fb-public's `{ post, comments }` as text: the post's whole text, then each comment. */
export function groupPostDocument(url: string, body: unknown): Document {
  const post = isObj(body) && isObj(body.post) ? body.post : null;
  if (!post) throw new Error("facebook: the walk read no post (private, removed or a wall)");
  const whole = str(post.all).trim() || str(post.text).trim();
  const head = POST_KEYS.map((k) => str(post[k]).trim())
    .filter(Boolean)
    .join(" · ");
  const comments = (isObj(body) && Array.isArray(body.comments) ? body.comments : [])
    .filter(isObj)
    .map((c) => `${str(c.author) || "someone"}: ${str(c.text).trim()}`)
    .filter((line) => !line.endsWith(": "));
  const text = [head, whole, comments.length ? `Comments:\n\n${comments.join("\n\n")}` : ""]
    .filter(Boolean)
    .join("\n\n");
  return {
    url,
    media: "text",
    ...(str(post.title) ? { title: str(post.title) } : {}),
    text,
  };
}

/** One route call; a refusal is a miss with the worker's words, no answer a Transient. */
export async function routeCall(
  sites: LadderClient,
  who: string,
  site: string,
  path: string,
  input: Obj,
  account?: string,
): Promise<unknown> {
  try {
    return await sites.call(site, "GET", path, input, account ? { account } : undefined);
  } catch (err) {
    if (err instanceof LadderCallError) {
      if (err.status === 429)
        throw new Refused(`${who}: ${site}'s cap is spent for today`, err.code ?? "rate_limited");
      // The profile stayed busy past the worker's wait: the read was never sent.
      if (err.status === 503) throw new Transient(`${who}: ${err.message}`);
      throw new Refused(`${who}: ${err.code ? `${err.code}: ` : ""}${err.message}`, err.code);
    }
    throw new Transient(`${who}: the worker did not answer (${(err as Error).message})`);
  }
}

const usable = (who: string, doc: Document): Document => {
  const junk = junkReason(doc);
  if (junk) throw new Error(`${who}: ${junk}`);
  return doc;
};

/** Top comments asked of a thread: enough to read the room, inside the route's 500. */
const COMMENTS = 200;

export function redditSource(o: { sites: LadderClient; account?: string }): Source {
  const read = async (url: string, signedIn: boolean): Promise<Document> => {
    const t = redditThread(url);
    if (!t) throw new Error(`reddit: not a thread: ${url}`);
    const input: Obj = {
      article: t.article,
      limit: COMMENTS,
      sort: "top",
      ...(t.comment ? { comment: t.comment, context: 3 } : {}),
    };
    const who = signedIn ? `reddit as ${o.account}` : "reddit signed out";
    const body = signedIn
      ? await routeCall(o.sites, who, "reddit", `/comments/${t.article}`, input, o.account)
      : await routeCall(o.sites, who, "reddit-public", `/comments/${t.article}`, input);
    return usable(who, threadDocument(url, body));
  };
  return {
    name: "reddit",
    kind: "open",
    cost: "browser",
    first: true,
    opens: (url) => redditThread(url) !== null,
    follows: (as, url) => as === "posts" && redditUser(url) !== null,
    async follow(_as, url, n) {
      const username = redditUser(url);
      if (!username) throw new Error(`reddit: not a user's page: ${url}`);
      const input = { username, limit: Math.min(n, 100), sort: "top" };
      const body = await routeCall(
        o.sites,
        "reddit signed out",
        "reddit-public",
        `/user/${username}/overview`,
        input,
      );
      return userHits(body);
    },
    async open(h) {
      if (!o.account) return read(h.url, false);
      try {
        return await read(h.url, false);
      } catch (err) {
        if (err instanceof Transient || err instanceof Gone) throw err;
        if (err instanceof Refused && err.code && NOT_FOR_SIGN_IN.has(err.code)) throw err;
        // Say it: a signed-in read spends the account's standing, and the agent counts it.
        console.warn(`${h.url}: ${(err as Error).message}; reading as ${o.account}`);
        try {
          return await read(h.url, true);
        } catch (again) {
          if (again instanceof Transient) throw again;
          throw new Error(`${(err as Error).message}; ${(again as Error).message}`);
        }
      }
    },
  };
}

export function facebookSource(o: { sites: LadderClient }): Source {
  return {
    name: "facebook",
    kind: "open",
    cost: "browser",
    first: true,
    opens: (url) => facebookPost(url) !== null,
    async open(h) {
      const p = facebookPost(h.url);
      if (!p) throw new Error(`facebook: not a group post: ${h.url}`);
      const body = await routeCall(
        o.sites,
        "facebook",
        "fb-public",
        `/groups/${p.group}/posts/${p.post}`,
        p,
      );
      return usable("facebook", groupPostDocument(h.url, body));
    },
  };
}
