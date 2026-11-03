/**
 * YouTube as a source. Hits: the Data API when there is a key (search, a channel's uploads,
 * exact counts), else yt-dlp's listings. An open reads the captions with yt-dlp, no model (the
 * API gives no captions for others' videos). `youtubeSee` reads what a video shows, only on the
 * agent's ask. Other hosts' posts list through yt-dlp.
 */

import type { Model } from "@wrenautomation/models";
import type { Ear } from "@wrenautomation/models/hear";
import type { VideoRead } from "@wrenautomation/read/video";
import {
  flatPlaylist,
  pageInfo,
  readYoutube,
  seeYoutube,
  type YtDlpEntry,
} from "@wrenautomation/read/video";
import type { Document } from "../document/index.js";
import { youtubeId } from "../engine/canonical.js";
import type { Source } from "../engine/ports.js";
import { metricsOf } from "./metrics.js";
import { QuotaSpent, type YoutubeApi } from "./youtube-api.js";

/** The model, with the sum of what its calls cost; undefined once a call came back unpriced. */
export function pricedOf(m: Model): { model: Model; usd: () => number | undefined } {
  let sum: number | undefined = 0;
  const add = (usd: number | undefined) => {
    sum = sum === undefined || usd === undefined ? undefined : sum + usd;
  };
  const model: Model = {
    id: m.id,
    provider: m.provider,
    takes: m.takes,
    async complete(r) {
      const reply = await m.complete(r);
      add(reply.usage?.usd);
      return reply;
    },
    async ask(prompt, shape, o) {
      const a = await m.ask(prompt, shape, o);
      add(a.usage?.usd);
      return a;
    },
  };
  return { model, usd: () => sum };
}

export const videoDocument = (r: VideoRead): Document => ({
  url: r.url,
  media: "video",
  title: r.title,
  text: r.body,
  ...(r.channel ? { channel: r.channel } : {}),
  ...(r.uploaded ? { date: r.uploaded } : {}),
  ...(r.duration !== undefined ? { length: r.duration } : {}),
});

/** One listed entry as a hit; `youtube` builds the watch URL from the id, other sites keep theirs. */
export const entryHit = (e: YtDlpEntry, site: "youtube" | "other" = "youtube") => {
  const own = e.webpage_url ?? e.url;
  const url = site === "youtube" && e.id ? `https://www.youtube.com/watch?v=${e.id}` : own;
  if (!url) return null;
  const by = e.channel ?? e.uploader;
  return {
    url,
    ...(e.title ? { title: e.title } : {}),
    ...(by ? { channel: by } : {}),
    ...(e.duration !== undefined ? { length: Math.round(e.duration) } : {}),
    ...(e.timestamp ? { date: new Date(e.timestamp * 1000).toISOString().slice(0, 10) } : {}),
    ...(e.description ? { snippet: e.description.slice(0, 300) } : {}),
    ...metricsOf({ views: e.view_count, likes: e.like_count, comments: e.comment_count }),
  };
};

/** A YouTube watch URL (or youtu.be): what the `youtube` source opens. */
export function isYoutube(url: string): boolean {
  try {
    return Boolean(youtubeId(new URL(url)));
  } catch {
    return false;
  }
}

/**
 * The page yt-dlp lists a URL's own posts from: a YouTube channel's videos (a video resolves
 * to its channel first), a TikTok profile. Null: not a page it lists.
 */
export function postsOf(
  url: string,
): { target: string; site: "youtube" | "other" } | "video" | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^(www|m)\./, "");
  const [first, second] = u.pathname.split("/").filter(Boolean);
  if (host === "youtube.com" || host === "youtu.be") {
    if (isYoutube(url)) return "video";
    if (first?.startsWith("@"))
      return { target: `https://www.youtube.com/${first}/videos`, site: "youtube" };
    if ((first === "channel" || first === "c" || first === "user") && second)
      return { target: `https://www.youtube.com/${first}/${second}/videos`, site: "youtube" };
    return null;
  }
  if (host === "tiktok.com" && first?.startsWith("@"))
    return { target: `https://www.tiktok.com/${first}`, site: "other" };
  return null;
}

/** Pause between YouTube reads: 4 at once drew 429s on captions and clips (11-03). */
export const OPEN_GAP_MS = 3_000;

export function ytdlpSource(o: {
  ytDlp: string;
  /** The Data API (`youtubeApi`): hits and counts without the home IP. */
  api?: YoutubeApi;
  n?: number;
  /** For tests: stand-ins for the yt-dlp calls. */
  list?: typeof flatPlaylist;
  read?: typeof readYoutube;
  info?: typeof pageInfo;
  /** For tests: the wait between reads. */
  pause?: (ms: number) => Promise<void>;
  warn?: (line: string) => void;
}): Source {
  const list = o.list ?? flatPlaylist;
  const read = o.read ?? readYoutube;
  const info = o.info ?? pageInfo;
  const warn = o.warn ?? ((l: string) => console.error(l));
  const pause = o.pause ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const inLine = queue(pause);
  // the day's quota spent: yt-dlp for the rest of this process
  let api = o.api;
  const viaApi = async <T>(call: (a: YoutubeApi) => Promise<T>): Promise<T | null> => {
    if (!api) return null;
    try {
      return await call(api);
    } catch (err) {
      if (!(err instanceof QuotaSpent)) throw err;
      warn(`${err.message}: yt-dlp lists YouTube from now on`);
      api = undefined;
      return null;
    }
  };
  return {
    name: "youtube",
    kind: "both",
    cost: "metered",
    // YouTube's own search knows no other site.
    keeps: (site) => /(^|\.)(youtube\.com|youtu\.be)$/i.test(site),
    async search(q) {
      const n = o.n ?? 10;
      const got = await viaApi((a) => a.search(q.terms, n));
      if (got) return got;
      const entries = await list(o.ytDlp, `ytsearch${n}:${q.terms}`);
      return entries.map((e) => entryHit(e)).filter((h): h is NonNullable<typeof h> => h !== null);
    },
    follows: (as, url) => as === "posts" && postsOf(url) !== null,
    async follow(_as, url, n) {
      let at = postsOf(url);
      if (at === "video" || at?.site === "youtube") {
        const got = await viaApi((a) => a.uploads(url, n));
        if (got) return got;
      }
      if (at === "video") {
        const v = await info(o.ytDlp, url);
        const channel = [v.channel_url, v.uploader_url].find((x) => typeof x === "string");
        at = typeof channel === "string" ? postsOf(channel) : null;
        if (!at || at === "video") throw new Error(`youtube: no channel for ${url}`);
      }
      if (!at) throw new Error(`youtube: no posts page for ${url}`);
      const site = at.site;
      // one call: a channel listing names the channel on the page, not on each entry
      const page = (await info(o.ytDlp, at.target, { start: 1, end: n })) as {
        channel?: string;
        uploader?: string;
        entries?: YtDlpEntry[];
      };
      const owner = page.channel ?? page.uploader;
      return (page.entries ?? [])
        .filter((e) => e.id || e.url || e.webpage_url)
        .map((e) =>
          entryHit(owner && !e.channel && !e.uploader ? { ...e, channel: owner } : e, site),
        )
        .filter((h): h is NonNullable<typeof h> => h !== null);
    },
    opens: isYoutube,
    // captions only, free: what the screen shows is `youtubeSee`, on the agent's ask
    open: (h) =>
      inLine(async () => {
        if (!isYoutube(h.url)) throw new Error(`youtube: not a YouTube page: ${h.url}`);
        const doc = videoDocument(await read(h.url, { ytDlp: o.ytDlp }));
        Object.defineProperty(doc, "usd", { value: 0, enumerable: false });
        return doc;
      }),
  };
}

/** One call at a time, a gap between: the open step runs 4 at once. */
function queue(pause: (ms: number) => Promise<void>) {
  let line: Promise<unknown> = Promise.resolve();
  let first = true;
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const next = line.then(async () => {
      if (!first) await pause(OPEN_GAP_MS);
      first = false;
      return fn();
    });
    line = next.catch(() => undefined);
    return next;
  };
}

/**
 * What a YouTube video shows, on the agent's ask only (`open --see`): the video downloaded, every
 * frame read by `eye` (Claude: its text and what it shows). A hit with no document gets its
 * words too: the captions, else `ear` hears the audio. The eye's calls are priced; an ear's are
 * not, so a heard read is unpriced.
 */
export function youtubeSee(o: {
  ytDlp: string;
  eye: Model;
  ear?: Ear;
  /** For tests: a stand-in for the read. */
  see?: typeof seeYoutube;
  pause?: (ms: number) => Promise<void>;
}): Source {
  const see = o.see ?? seeYoutube;
  const inLine = queue(o.pause ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))));
  return {
    name: "youtube-see",
    kind: "open",
    cost: "metered",
    asked: true,
    opens: isYoutube,
    open: (h, opt) =>
      inLine(async () => {
        const priced = pricedOf(o.eye);
        const r = await see(h.url, {
          ytDlp: o.ytDlp,
          eye: priced.model,
          words: !opt?.read,
          ...(o.ear ? { ear: o.ear } : {}),
        });
        const doc = videoDocument(r);
        const usd = r.heard ? undefined : priced.usd();
        if (usd !== undefined) Object.defineProperty(doc, "usd", { value: usd, enumerable: false });
        return doc;
      }),
  };
}
