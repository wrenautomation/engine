/**
 * yt-dlp as a source: `ytsearchN:<terms>` for hits (what the listing shows for free), and a
 * YouTube video read whole (captions, else Gemini hears it) as one document. Other hosts' videos
 * need the watcher's keys: not here yet. Metered: a read without captions costs a model call.
 */
import type { Document } from "@wrenautomation/falcon/document";
import type { VideoRead } from "@wrenautomation/falcon/video";
import { youtubeId } from "../engine/canonical.js";
import type { Source } from "../engine/ports.js";
import { flatPlaylist, type YtDlpEntry } from "../video/list.js";
import { readYoutube } from "../video/read.js";

export const videoDocument = (r: VideoRead): Document => ({
  url: r.url,
  media: "video",
  title: r.title,
  text: r.body,
  ...(r.channel ? { channel: r.channel } : {}),
  ...(r.uploaded ? { date: r.uploaded } : {}),
  ...(r.duration !== undefined ? { length: r.duration } : {}),
});

export const entryHit = (e: YtDlpEntry) => {
  const url = e.id ? `https://www.youtube.com/watch?v=${e.id}` : (e.webpage_url ?? e.url);
  if (!url) return null;
  const by = e.channel ?? e.uploader;
  return {
    url,
    ...(e.title ? { title: e.title } : {}),
    ...(by ? { channel: by } : {}),
    ...(e.duration !== undefined ? { length: Math.round(e.duration) } : {}),
    ...(e.timestamp ? { date: new Date(e.timestamp * 1000).toISOString().slice(0, 10) } : {}),
    ...(e.description ? { snippet: e.description.slice(0, 300) } : {}),
  };
};

export function ytdlpSource(o: {
  ytDlp: string;
  geminiKeys?: readonly string[];
  n?: number;
  /** For tests: stand-ins for the two yt-dlp calls. */
  list?: typeof flatPlaylist;
  read?: typeof readYoutube;
}): Source {
  const list = o.list ?? flatPlaylist;
  const read = o.read ?? readYoutube;
  return {
    name: "youtube",
    kind: "both",
    cost: "metered",
    async search(q) {
      const entries = await list(o.ytDlp, `ytsearch${o.n ?? 10}:${q.terms}`);
      return entries.map(entryHit).filter((h): h is NonNullable<typeof h> => h !== null);
    },
    async open(h) {
      let u: URL;
      try {
        u = new URL(h.url);
      } catch {
        return null;
      }
      if (!youtubeId(u)) return null;
      return videoDocument(
        await read(h.url, {
          ytDlp: o.ytDlp,
          ...(o.geminiKeys ? { geminiKeys: o.geminiKeys } : {}),
        }),
      );
    },
  };
}
