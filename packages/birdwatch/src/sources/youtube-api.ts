/**
 * YouTube Data API v3: search, a channel's uploads and exact counts, no home IP. 10k units a day
 * on one key: search 100, every list 1 (50 ids a call). No captions for others' videos: an open
 * still reads them with yt-dlp.
 */
import type { HitViewIn } from "../engine/types.js";
import { metricsOf } from "./metrics.js";

const API = "https://www.googleapis.com/youtube/v3";

/** The day's quota is spent (or the key is refused): the caller falls back to yt-dlp. */
export class QuotaSpent extends Error {}

interface Video {
  id: string;
  snippet?: {
    title?: string;
    description?: string;
    channelTitle?: string;
    channelId?: string;
    publishedAt?: string;
  };
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
  contentDetails?: { duration?: string };
}

/** `PT1H2M3S` in seconds; null when it is not one. */
export function isoSeconds(d: string | undefined): number | null {
  const m = d ? /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(d) : null;
  if (!m) return null;
  const [, days, h, min, s] = m.map((x) => Number(x ?? 0));
  return (days as number) * 86400 + (h as number) * 3600 + (min as number) * 60 + (s as number);
}

const count = (s: string | undefined) => (s === undefined ? undefined : Number(s));

export const videoHit = (v: Video): HitViewIn => {
  const s = v.snippet ?? {};
  const length = isoSeconds(v.contentDetails?.duration);
  return {
    url: `https://www.youtube.com/watch?v=${v.id}`,
    ...(s.title ? { title: s.title } : {}),
    ...(s.channelTitle ? { channel: s.channelTitle } : {}),
    ...(length !== null ? { length } : {}),
    ...(s.publishedAt ? { date: s.publishedAt.slice(0, 10) } : {}),
    ...(s.description ? { snippet: s.description.slice(0, 300) } : {}),
    ...metricsOf({
      views: count(v.statistics?.viewCount),
      likes: count(v.statistics?.likeCount),
      comments: count(v.statistics?.commentCount),
    }),
  };
};

export interface YoutubeApi {
  search(terms: string, n: number): Promise<HitViewIn[]>;
  /** A channel's newest uploads; `channel` is a channel URL, an @handle page or a video URL. */
  uploads(channel: string, n: number): Promise<HitViewIn[]>;
  videos(ids: readonly string[]): Promise<HitViewIn[]>;
}

export function youtubeApi(o: { key: string; fetch?: typeof fetch }): YoutubeApi {
  const fetchFn = o.fetch ?? fetch;
  const get = async <T>(path: string, params: Record<string, string>): Promise<T> => {
    const q = new URLSearchParams({ ...params, key: o.key });
    const res = await fetchFn(`${API}/${path}?${q}`, { signal: AbortSignal.timeout(30_000) });
    if (res.ok) return (await res.json()) as T;
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; errors?: { reason?: string }[] };
    };
    const reason = body.error?.errors?.[0]?.reason ?? "";
    const why = `youtube api ${path}: HTTP ${res.status} ${reason} ${body.error?.message ?? ""}`;
    if (res.status === 403 && /quota|dailyLimit|rateLimit|keyInvalid|forbidden/i.test(reason))
      throw new QuotaSpent(why.trim());
    if (res.status === 400 && /keyInvalid|badRequest/i.test(reason) && /key/i.test(why))
      throw new QuotaSpent(why.trim());
    throw new Error(why.trim());
  };
  const videos = async (ids: readonly string[]) => {
    const out: HitViewIn[] = [];
    for (let i = 0; i < ids.length; i += 50) {
      const page = await get<{ items?: Video[] }>("videos", {
        part: "snippet,statistics,contentDetails",
        id: ids.slice(i, i + 50).join(","),
        maxResults: "50",
      });
      // the API's order is not the ids'
      const byId = new Map((page.items ?? []).map((v) => [v.id, v]));
      for (const id of ids.slice(i, i + 50)) {
        const v = byId.get(id);
        if (v) out.push(videoHit(v));
      }
    }
    return out;
  };
  const channelOf = async (url: string): Promise<string> => {
    const u = new URL(url);
    const [first, second] = u.pathname.split("/").filter(Boolean);
    const video = u.searchParams.get("v") ?? (u.hostname.endsWith("youtu.be") ? first : null);
    if (video || first === "shorts" || first === "live") {
      const id = video ?? second;
      const page = await get<{ items?: Video[] }>("videos", { part: "snippet", id: id ?? "" });
      const c = page.items?.[0]?.snippet?.channelId;
      if (!c) throw new Error(`youtube api: no channel for ${url}`);
      return c;
    }
    if (first === "channel" && second) return second;
    const by: Record<string, string> | null = first?.startsWith("@")
      ? { forHandle: first }
      : first === "user" && second
        ? { forUsername: second }
        : first === "c" && second
          ? { forHandle: `@${second}` }
          : null;
    if (!by) throw new Error(`youtube api: not a channel page: ${url}`);
    const page = await get<{ items?: { id: string }[] }>("channels", { part: "id", ...by });
    const c = page.items?.[0]?.id;
    if (!c) throw new Error(`youtube api: no channel for ${url}`);
    return c;
  };
  return {
    async search(terms, n) {
      const page = await get<{ items?: { id?: { videoId?: string } }[] }>("search", {
        part: "id",
        type: "video",
        q: terms,
        maxResults: String(Math.min(n, 50)),
      });
      return videos((page.items ?? []).flatMap((i) => (i.id?.videoId ? [i.id.videoId] : [])));
    },
    async uploads(url, n) {
      const channel = await channelOf(url);
      // a channel's uploads playlist is its id with UC -> UU
      const playlist = channel.replace(/^UC/, "UU");
      const ids: string[] = [];
      let pageToken: string | undefined;
      while (ids.length < n) {
        const page = await get<{
          items?: { contentDetails?: { videoId?: string } }[];
          nextPageToken?: string;
        }>("playlistItems", {
          part: "contentDetails",
          playlistId: playlist,
          maxResults: String(Math.min(50, n - ids.length)),
          ...(pageToken ? { pageToken } : {}),
        });
        ids.push(...(page.items ?? []).flatMap((i) => i.contentDetails?.videoId ?? []));
        pageToken = page.nextPageToken;
        if (!pageToken) break;
      }
      return videos(ids.slice(0, n));
    },
    videos,
  };
}
