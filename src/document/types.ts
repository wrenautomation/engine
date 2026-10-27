/**
 * What the research engine reads and keeps: a document (one URL read whole), a finding (one
 * fact drawn from it) and its proof (where in the document). zod shapes, because a ledger
 * parses them back. Who found it (`from`, `by`) is the ledger's envelope, not the finding's.
 */
import { z } from "zod";

export const Media = z.enum(["html", "pdf", "text", "video", "audio"]);
export type Media = z.infer<typeof Media>;

/** One URL, read whole: a page's text, a video's markdown. The same free fields a hit shows. */
export const Document = z.object({
  url: z.string().min(1),
  media: Media,
  title: z.string().optional(),
  /** All of it: never cut here. */
  text: z.string(),
  channel: z.string().optional(),
  /** ISO date, when the document says one. */
  date: z.string().optional(),
  /** Seconds, for video and audio. */
  length: z.number().nonnegative().optional(),
});
export type Document = z.infer<typeof Document>;

/** Where a finding rests: the exact words, a second into a recording, or a frame of it. */
export const Proof = z
  .object({
    url: z.string().min(1),
    /** Copied character for character from the document. */
    quote: z.string().min(1).optional(),
    /** Seconds into a video or audio. */
    timestamp: z.number().nonnegative().optional(),
    /** A frame's stamp (`mm:ss`) of a watched video. */
    frame: z.string().min(1).optional(),
  })
  .refine((p) => p.quote !== undefined || p.timestamp !== undefined || p.frame !== undefined, {
    message: "a proof needs a quote, a timestamp or a frame",
  });
export type Proof = z.infer<typeof Proof>;

/**
 * One fact with its proof. `kind` names the extractor's sort of finding: `claim` in v1. Three
 * signs this is too thin, to watch for: a finding needs two proofs, a proof needs a span inside
 * a quote, a finding points at another finding.
 */
export const Finding = z.object({
  kind: z.string().min(1),
  /** One plain sentence. */
  text: z.string().min(1),
  proof: Proof,
});
export type Finding = z.infer<typeof Finding>;
