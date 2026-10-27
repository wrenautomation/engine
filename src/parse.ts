/** The one reader of a model's JSON answer. */
import type { ZodType } from "zod";

/** Every balanced `{...}` in a text, by start position: an outer object comes before its inner ones. */
function* objects(text: string): Generator<string> {
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        yield text.slice(start, i + 1);
        break;
      }
    }
  }
}

export class NoAnswer extends Error {
  readonly text: string;
  /** Why the closest candidate failed the shape; empty when no JSON object parsed. */
  readonly issues: string;
  constructor(text: string, issues: string) {
    super(
      `no answer of the expected shape${issues ? ` (${issues})` : ""} in: ${text.slice(0, 400)}`,
    );
    this.name = "NoAnswer";
    this.text = text;
    this.issues = issues;
  }
}

/**
 * The first JSON object of the shape in a model's text, found by brace balance: fences, prose
 * and stray braces around it are passed over. Throws `NoAnswer` when nothing parses.
 */
export function parseAnswer<T>(text: string, shape: ZodType<T>): T {
  let issues = "";
  for (const candidate of objects(text)) {
    let json: unknown;
    try {
      json = JSON.parse(candidate);
    } catch {
      continue;
    }
    const out = shape.safeParse(json);
    if (out.success) return out.data;
    if (!issues)
      issues = out.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
  }
  throw new NoAnswer(text, issues);
}

/** Lone UTF-16 surrogates out: a vendor's JSON parser refuses them. */
export const wellFormed = (s: string): string =>
  s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
