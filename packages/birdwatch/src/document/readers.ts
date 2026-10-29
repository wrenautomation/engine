/**
 * A reader turns what a source fetched (markup, bytes or text) into one `Document`. The
 * registry is keyed by media; a run picks the reader by the content type it got. Three ship
 * here: html, pdf, text. Video and audio readers need tools and keys, so the caller registers
 * those (the readers over yt-dlp in `@wrenautomation/read/video` return a `Document` directly).
 */
import { pdfText, readPage, tidy } from "@wrenautomation/read/text";
import { type Document, type Media, Media as MediaShape } from "./types.js";

/** What a source fetched for one URL. `text` for markup and text, `bytes` for a file. */
export interface ReadInput {
  url: string;
  text?: string;
  bytes?: Uint8Array;
  /** What the source already knows: a hit's title, channel, date, length. */
  title?: string;
  channel?: string;
  date?: string;
  length?: number;
}

export interface Reader {
  media: Media;
  /** Null when the input cannot be read as this media (a scanned PDF, an empty page). */
  read(input: ReadInput): Promise<Document | null>;
}

const free = (input: ReadInput): Partial<Document> => {
  const out: Partial<Document> = {};
  if (input.title) out.title = input.title;
  if (input.channel) out.channel = input.channel;
  if (input.date) out.date = input.date;
  if (input.length !== undefined) out.length = input.length;
  return out;
};

const textOf = (input: ReadInput): string =>
  input.text ?? (input.bytes ? new TextDecoder().decode(input.bytes) : "");

export const htmlReader: Reader = {
  media: "html",
  async read(input) {
    const page = readPage(textOf(input), input.url);
    if (!page.text.trim()) return null;
    return {
      ...free(input),
      ...(page.title ? { title: page.title } : {}),
      url: input.url,
      media: "html",
      text: page.text,
    };
  },
};

export const pdfReader: Reader = {
  media: "pdf",
  async read(input) {
    if (!input.bytes) return null;
    const text = await pdfText(input.bytes);
    return text ? { ...free(input), url: input.url, media: "pdf", text } : null;
  },
};

export const textReader: Reader = {
  media: "text",
  async read(input) {
    const text = tidy(textOf(input));
    return text ? { ...free(input), url: input.url, media: "text", text } : null;
  },
};

/** The readers by media. A caller adds its own (`video`, `audio`) or swaps one. */
export const defaultReaders = (): Map<Media, Reader> =>
  new Map([htmlReader, pdfReader, textReader].map((r) => [r.media, r]));

/** The media of a fetched body, from its content type first, then the URL's extension. */
export function mediaOf(contentType: string | null | undefined, url: string): Media | null {
  const type = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (type === "application/pdf") return "pdf";
  if (type === "text/html" || type === "application/xhtml+xml") return "html";
  if (type.startsWith("text/")) return "text";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  let path = "";
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return null;
  }
  if (path.endsWith(".pdf")) return "pdf";
  if (/\.(txt|md|csv)$/.test(path)) return "text";
  if (/\.(mp4|webm|mov|mkv)$/.test(path)) return "video";
  if (/\.(mp3|m4a|wav|ogg)$/.test(path)) return "audio";
  if (!type || type === "application/octet-stream") return null;
  return MediaShape.safeParse(type).success ? (type as Media) : null;
}
