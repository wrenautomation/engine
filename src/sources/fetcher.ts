/**
 * The polite fetcher as an open source: one GET, the body read by falcon's reader for its media.
 * A 4xx or an empty page is null (the next source may try); a transport failure throws.
 */
import { defaultReaders, type Media, mediaOf, type Reader } from "@wrenautomation/falcon/document";
import { youtubeId } from "../engine/canonical.js";
import type { Source } from "../engine/ports.js";
import type { PoliteFetcher } from "../fetch/fetcher.js";

export interface Opener {
  open(url: string): Promise<Response>;
}

/** What a hit already shows for free, carried onto the document when the page has nothing better. */
interface Shown {
  title?: string | undefined;
  channel?: string | undefined;
  date?: string | undefined;
  length?: number | undefined;
}

const free = (h: Shown) => ({
  ...(h.title ? { title: h.title } : {}),
  ...(h.channel ? { channel: h.channel } : {}),
  ...(h.date ? { date: h.date } : {}),
  ...(h.length !== undefined ? { length: h.length } : {}),
});

export async function readResponse(
  res: Response,
  url: string,
  readers: Map<Media, Reader>,
  hit: Shown = {},
) {
  if (res.status >= 400) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  const media = mediaOf(res.headers.get("content-type"), res.url || url);
  const reader = media ? readers.get(media) : undefined;
  if (!reader || media === "video" || media === "audio") {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const input =
    media === "pdf" ? { bytes } : { text: new TextDecoder("utf8", { fatal: false }).decode(bytes) };
  return reader.read({ url: res.url || url, ...input, ...free(hit) });
}

export function fetcherSource(o: {
  fetcher: PoliteFetcher | Opener;
  readers?: Map<Media, Reader>;
}): Source {
  const readers = o.readers ?? defaultReaders();
  return {
    name: "fetcher",
    kind: "open",
    cost: "free",
    async open(h) {
      if (!/^https?:/.test(h.url)) return null;
      // A video page is not a document: the `youtube` source reads it, when it is in the allow-list.
      if (youtubeId(new URL(h.url))) return null;
      return readResponse(await o.fetcher.open(h.url), h.url, readers, h);
    },
  };
}
