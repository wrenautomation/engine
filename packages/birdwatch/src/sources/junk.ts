/**
 * A page that answered 200 and still holds nothing: a captcha wall, a 404 shell, an empty body.
 * Both open sources ask before they return a document, so such a page is a miss with a reason
 * (spend ok:false, a gap), never a read.
 */
import type { Document } from "../document/index.js";

/** Fewer characters than this is no page: a shell, a redirect stub, a bare title. */
export const FLOOR = 200;

const WALLS =
  /prove your humanity|just a moment|are you a (?:robot|human)|verify you are human|attention required|access denied|page not found|not found\b|403 forbidden|404\b|blocked|captcha|security check|enable javascript/i;

/** Why a document is junk, or null when it reads as a page. */
export function junkReason(doc: Document, status?: number | null): string | null {
  if (status !== undefined && status !== null && status >= 400) return `HTTP ${status}`;
  const title = doc.title?.trim() ?? "";
  if (WALLS.test(title)) return `a wall, not a page: "${title}"`;
  const n = doc.text.trim().length;
  if (n < FLOOR) return `only ${n} characters of text, no page`;
  return null;
}
