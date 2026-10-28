/**
 * The polite fetcher as an open source: one GET, the body read by falcon's reader for its media.
 * It opens http(s) pages that are not videos. A 4xx, a media no reader takes or an empty page is
 * a miss (a throw with the reason: the spend says so, the next source may try); a transport
 * failure throws a Transient.
 */
import { defaultReaders, type Media, mediaOf, type Reader } from "@wrenautomation/falcon/document";
import { transport } from "@wrenautomation/models";
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

/** An http(s) URL that is not a YouTube page: the `youtube` source reads those. */
export function isPage(url: string): boolean {
  if (!/^https?:/.test(url)) return false;
  try {
    return !youtubeId(new URL(url));
  } catch {
    return false;
  }
}

export async function readResponse(
  res: Response,
  url: string,
  readers: Map<Media, Reader>,
  hit: Shown = {},
  what = "fetcher",
) {
  if (res.status >= 400) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`${what}: HTTP ${res.status}`);
  }
  const type = res.headers.get("content-type");
  const media = mediaOf(type, res.url || url);
  const reader = media ? readers.get(media) : undefined;
  if (!reader || media === "video" || media === "audio") {
    await res.body?.cancel().catch(() => {});
    throw new Error(`${what}: no reader for ${media ?? type ?? "an unknown media"}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const input =
    media === "pdf" ? { bytes } : { text: new TextDecoder("utf8", { fatal: false }).decode(bytes) };
  const doc = await reader.read({ url: res.url || url, ...input, ...free(hit) });
  if (!doc) throw new Error(`${what}: nothing to read in the ${media}`);
  return doc;
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
    opens: isPage,
    async open(h) {
      if (!isPage(h.url)) throw new Error(`fetcher: not a page: ${h.url}`);
      const res = await o.fetcher.open(h.url).catch((err) => {
        throw transport("fetcher", err);
      });
      return readResponse(res, h.url, readers, h);
    },
  };
}
