/**
 * Hacker News through Algolia's HN API (hn.algolia.com, free, no key): stories for a query, a
 * user's stories, and a thread read as data (`items/{id}`: the story and every comment nested).
 * Each hit carries the story's points and comment count, so a thread's draw is read for free.
 */

import { httpError, transport } from "@wrenautomation/models";
import type { Document } from "../document/index.js";
import type { Source } from "../engine/ports.js";
import type { HitViewIn } from "../engine/types.js";
import { metricsOf } from "./metrics.js";

export const HN_API = "https://hn.algolia.com/api/v1";
const HN = "https://news.ycombinator.com";
/** Comments kept of a thread, depth first: enough to read the room. */
const COMMENTS = 200;

interface AlgoliaStory {
  objectID: string;
  title?: string | null;
  url?: string | null;
  author?: string | null;
  points?: number | null;
  num_comments?: number | null;
  created_at?: string | null;
  story_text?: string | null;
}

interface AlgoliaItem {
  id: number;
  type?: string;
  title?: string | null;
  url?: string | null;
  author?: string | null;
  points?: number | null;
  created_at?: string | null;
  text?: string | null;
  children?: AlgoliaItem[];
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** HN's comment HTML as text: paragraphs kept, links as their text, entities decoded. */
export function hnText(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<p>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
      if (code[0] === "#")
        return String.fromCodePoint(
          code[1]?.toLowerCase() === "x"
            ? Number.parseInt(code.slice(2), 16)
            : Number(code.slice(1)),
        );
      return ENTITIES[code.toLowerCase()] ?? m;
    })
    .trim();
}

/** The story id of a thread URL (`news.ycombinator.com/item?id=N`). */
export function hnItem(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname !== "news.ycombinator.com" || u.pathname !== "/item") return null;
    const id = u.searchParams.get("id");
    return id && /^\d+$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** The user of a profile URL (`news.ycombinator.com/user?id=name`). */
export function hnUser(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname !== "news.ycombinator.com" || u.pathname !== "/user") return null;
    const id = u.searchParams.get("id");
    return id && /^[\w-]{2,15}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** A story as a hit: the thread's page, since the comments are what a read is for. */
export const storyHit = (s: AlgoliaStory): HitViewIn => {
  const text = hnText(s.story_text);
  const snippet = text ? text.slice(0, 300) : s.url ? `Link: ${s.url}` : "";
  return {
    url: `${HN}/item?id=${s.objectID}`,
    ...(s.title ? { title: s.title } : {}),
    ...(s.author ? { channel: `hn/${s.author}` } : {}),
    ...(s.created_at ? { date: s.created_at.slice(0, 10) } : {}),
    ...(snippet ? { snippet } : {}),
    ...metricsOf({ likes: s.points, comments: s.num_comments }),
  };
};

/** The thread as text: the story, then each comment with its depth marked. */
export function hnThreadDocument(url: string, item: AlgoliaItem): Document {
  const lines: string[] = [];
  const walk = (c: AlgoliaItem, depth: number) => {
    if (lines.length >= COMMENTS) return;
    const text = hnText(c.text);
    if (text)
      lines.push(`${">".repeat(depth)}${depth ? " " : ""}${c.author ?? "[deleted]"}: ${text}`);
    for (const k of c.children ?? []) walk(k, depth + 1);
  };
  for (const k of item.children ?? []) walk(k, 0);
  const head = [
    item.author ? `by ${item.author}` : "",
    typeof item.points === "number" ? `${item.points} points` : "",
    lines.length ? `${lines.length} comments` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const body = hnText(item.text) || (item.url ? `Link: ${item.url}` : "");
  const text = [
    item.title ?? "",
    head,
    body,
    lines.length ? `Comments:\n\n${lines.join("\n\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    url,
    media: "text",
    ...(item.title ? { title: item.title } : {}),
    text,
    ...(item.author ? { channel: `hn/${item.author}` } : {}),
    ...(item.created_at ? { date: item.created_at.slice(0, 10) } : {}),
  };
}

export function hn(o: { fetchFn?: typeof fetch; n?: number } = {}): Source {
  const fetchFn = o.fetchFn ?? fetch;
  const get = async <T>(path: string): Promise<T> => {
    const res = await fetchFn(`${HN_API}/${path}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    }).catch((err) => {
      throw transport("hn", err);
    });
    if (!res.ok) throw httpError("hn", res);
    return (await res.json()) as T;
  };
  const stories = async (path: string) =>
    ((await get<{ hits?: AlgoliaStory[] }>(path)).hits ?? [])
      .filter((s) => typeof s.objectID === "string")
      .map(storyHit);
  return {
    name: "hn",
    kind: "both",
    cost: "free",
    first: true,
    keeps: (site) => /(^|\.)ycombinator\.com$/i.test(site),
    search: (q) =>
      stories(`search?query=${encodeURIComponent(q.terms)}&tags=story&hitsPerPage=${o.n ?? 20}`),
    follows: (as, url) => as === "posts" && hnUser(url) !== null,
    follow(_as, url, n) {
      const user = hnUser(url);
      if (!user) throw new Error(`hn: not a user's page: ${url}`);
      return stories(`search_by_date?tags=story,author_${user}&hitsPerPage=${Math.min(n, 100)}`);
    },
    opens: (url) => hnItem(url) !== null,
    async open(h) {
      const id = hnItem(h.url);
      if (!id) throw new Error(`hn: not a thread: ${h.url}`);
      return hnThreadDocument(h.url, await get<AlgoliaItem>(`items/${id}`));
    },
  };
}
