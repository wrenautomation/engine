/**
 * LinkedIn through the desk's `linkedin` site routes, as the account the person names
 * (`BIRDWATCH_ACCOUNTS=linkedin=linkedin@wren`): never a default, since the bare `linkedin`
 * account is a person's own profile. Search is the posts page for a keyword (a daily cap, so only
 * a query pinned to linkedin.com); a follow lists a member's or a company's own posts. Each hit
 * carries the post's reactions and comment count, so an author's baseline comes for free.
 */

import type { LadderClient } from "@wrenautomation/read/fetch";
import type { Source } from "../engine/ports.js";
import type { HitViewIn } from "../engine/types.js";
import { metricsOf } from "./metrics.js";
import { routeCall } from "./sites.js";

/**
 * Posts per page read: the route's most, so one cap unit takes all LinkedIn serves. A search
 * serves 25-50 and stops (3 live reads, 2026-11-03); a read takes 3-8 min at a person's pace.
 */
const SEARCH_MAX = 100;

/** A profile or Page URL: `in/<vanity>` or `company/<handle>`, the hit's channel. */
export function linkedinPage(url: string): { kind: "in" | "company"; id: string } | null {
  try {
    const u = new URL(url);
    if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) return null;
    const m = /^\/(in|company)\/([^/?#]+)\/?/.exec(u.pathname);
    return m?.[1] && m[2]
      ? { kind: m[1] as "in" | "company", id: decodeURIComponent(m[2]).toLowerCase() }
      : null;
  } catch {
    return null;
  }
}

const channelOf = (page: { kind: string; id: string } | null, author?: string) =>
  page ? `${page.kind}/${page.id}` : author;

interface Post {
  text?: string;
  author?: string;
  authorUrl?: string | null;
  at?: string;
  reactions?: number;
  comments?: number;
  url?: string;
  kind?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** One post of a route's answer as a hit; `channel` names the author when the post does not. */
export const postHit = (p: Post, channel?: string): HitViewIn | null => {
  if (!p.url) return null;
  const text = (p.text ?? "").trim();
  const by = channel ?? channelOf(p.authorUrl ? linkedinPage(p.authorUrl) : null, p.author);
  return {
    url: p.url,
    ...(by ? { channel: by } : {}),
    ...(p.at ? { date: p.at.slice(0, 10) } : {}),
    ...(text ? { snippet: text.slice(0, 300) } : {}),
    ...metricsOf({ likes: p.reactions, comments: p.comments }),
  };
};

const hitsOf = (body: unknown, key: "posts" | "activity", channel?: string): HitViewIn[] => {
  const list = isObj(body) && Array.isArray(body[key]) ? (body[key] as Post[]) : [];
  return list
    .filter((p) => key !== "activity" || p.kind === "post") // own posts only: a repost is another's draw
    .map((p) => postHit(p, channel))
    .filter((h): h is HitViewIn => h !== null);
};

export function linkedinSource(o: { sites: LadderClient; account: string }): Source {
  const who = `linkedin as ${o.account}`;
  return {
    name: "linkedin",
    kind: "search",
    cost: "browser",
    keeps: (site) => /(^|\.)linkedin\.com$/i.test(site),
    pinnedOnly: true,
    presets: true,
    async search(q) {
      // no preset: LinkedIn's own default (relevance, any date)
      const input = {
        keywords: q.terms,
        max: SEARCH_MAX,
        ...(q.preset ? { preset: q.preset } : {}),
      };
      const body = await routeCall(
        o.sites,
        who,
        "linkedin",
        "/search/results/content",
        input,
        o.account,
      );
      return hitsOf(body, "posts");
    },
    follows: (as, url) => as === "posts" && linkedinPage(url) !== null,
    async follow(_as, url, n) {
      const page = linkedinPage(url);
      if (!page) throw new Error(`linkedin: not a profile or Page: ${url}`);
      const channel = channelOf(page);
      if (page.kind === "company") {
        const input = { company: page.id, max: Math.min(n, SEARCH_MAX) };
        const body = await routeCall(
          o.sites,
          who,
          "linkedin",
          `/company/${page.id}/posts`,
          input,
          o.account,
        );
        return hitsOf(body, "posts", channel);
      }
      const input = { vanity: page.id, max: Math.min(n, SEARCH_MAX) };
      const body = await routeCall(
        o.sites,
        who,
        "linkedin",
        `/in/${page.id}/activity`,
        input,
        o.account,
      );
      return hitsOf(body, "activity", channel);
    },
  };
}
