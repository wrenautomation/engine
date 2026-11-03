/**
 * yt-dlp as a source: `ytsearchN:<terms>` for hits (what the listing shows for free), and a
 * YouTube video read whole (captions, else Gemini hears it) as one document. Other hosts' videos
 * need the watcher's keys: not here yet. Metered: a read without captions costs a model call.
 */

import type { Model } from "@wrenautomation/models";
import type { VideoRead } from "@wrenautomation/read/video";
import { flatPlaylist, pageInfo, readYoutube, type YtDlpEntry } from "@wrenautomation/read/video";
import type { Document } from "../document/index.js";
import { youtubeId } from "../engine/canonical.js";
import type { Source } from "../engine/ports.js";
import { metricsOf } from "./metrics.js";

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

export function ytdlpSource(o: {
  ytDlp: string;
  /**
   * The model that reads what a video shows, made on first open (`geminiVideo` checks its keys
   * over the network): listing sources costs no call.
   */
  video?: () => Promise<Model | null>;
  n?: number;
  /** For tests: stand-ins for the yt-dlp calls. */
  list?: typeof flatPlaylist;
  read?: typeof readYoutube;
  info?: typeof pageInfo;
}): Source {
  const list = o.list ?? flatPlaylist;
  const read = o.read ?? readYoutube;
  const info = o.info ?? pageInfo;
  let video: Promise<Model | null> | undefined;
  const videoModel = (make: () => Promise<Model | null>) => {
    video ??= make();
    return video;
  };
  return {
    name: "youtube",
    kind: "both",
    cost: "metered",
    // YouTube's own search knows no other site.
    keeps: (site) => /(^|\.)(youtube\.com|youtu\.be)$/i.test(site),
    async search(q) {
      const entries = await list(o.ytDlp, `ytsearch${o.n ?? 10}:${q.terms}`);
      return entries.map((e) => entryHit(e)).filter((h): h is NonNullable<typeof h> => h !== null);
    },
    follows: (as, url) => as === "posts" && postsOf(url) !== null,
    async follow(_as, url, n) {
      let at = postsOf(url);
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
    async open(h) {
      if (!isYoutube(h.url)) throw new Error(`youtube: not a YouTube page: ${h.url}`);
      const model = o.video ? await videoModel(o.video) : null;
      const priced = model ? pricedOf(model) : null;
      const doc = videoDocument(
        await read(h.url, { ytDlp: o.ytDlp, ...(priced ? { video: priced.model } : {}) }),
      );
      // captions: free; heard: the model's priced calls; an unpriced call leaves it unpriced
      const usd = priced ? priced.usd() : 0;
      // hidden: the spend reads it, the stored document never carries it
      if (usd !== undefined) Object.defineProperty(doc, "usd", { value: usd, enumerable: false });
      return doc;
    },
  };
}
