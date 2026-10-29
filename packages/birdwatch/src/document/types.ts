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

/** How much of the ask one document served: rich, thin, off (another subject) or empty (no text). */
export const Quality = z.enum(["rich", "thin", "off", "empty"]);
export type Quality = z.infer<typeof Quality>;

/**
 * The extractor's word on one document after its findings: the quality, and the gap, one
 * sentence on what the ask still lacks after this document. A filter's report to the agent,
 * never a query: the agent reads the round's verdicts before it picks the edge.
 */
export const Verdict = z.object({
  quality: Quality,
  gap: z.string().min(1).optional(),
});
export type Verdict = z.infer<typeof Verdict>;

/**
 * What several findings say together, in the agent's words: one sentence, the findings it
 * rests on, and how many distinct sites they come from (counted by code from the findings'
 * proofs, never claimed). A pattern on one site is a claim; the count is what makes it a
 * pattern. A reader judges the sentence; the count tells how far to trust it.
 */
export const Pattern = z.object({
  /** One plain sentence. */
  text: z.string().min(1),
  /** Ids of the findings it rests on, in the ledger that holds them. */
  findings: z.array(z.string().min(1)).min(1),
  /** Distinct hosts across those findings' proofs. */
  sources: z.number().int().positive(),
});
export type Pattern = z.infer<typeof Pattern>;

/** The host of a proof's URL, lower case, without `www.`; the URL itself when it is not one. */
export const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return url;
  }
};

/** A pattern over findings: the source count is the distinct hosts of their proofs. */
export function patternOf(
  text: string,
  findings: readonly { id: string; proof: { url: string } }[],
): Pattern {
  const sentence = text.replace(/\s+/g, " ").trim();
  if (!sentence) throw new Error("a pattern needs a sentence");
  if (!findings.length) throw new Error("a pattern needs at least one finding");
  return {
    text: sentence,
    findings: findings.map((f) => f.id),
    sources: new Set(findings.map((f) => hostOf(f.proof.url))).size,
  };
}
