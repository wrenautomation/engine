/**
 * Tiny HTML reading: visible text, links, title, mailto/tel hrefs in one pass.
 * Deliberately not a DOM: enrichment needs the words and the links, not the tree.
 * htmlparser2's streaming parser feeds the Extractor; it is tolerant of the malformed
 * markup small-business sites serve and closes what HTML implies closed. Never throws:
 * a pathological page degrades to whatever was read so far, never sinks a crawl.
 */

import { Parser } from "htmlparser2";
import { decodeHtml } from "../text/entities.js";

const SKIP_CONTENT: ReadonlySet<string> = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
]);
/** Elements that end a run of inline text; a newline keeps extracted text readable. */
const BLOCK: ReadonlySet<string> = new Set([
  "p",
  "div",
  "br",
  "li",
  "tr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "section",
  "article",
  "header",
  "footer",
  "nav",
  "main",
  "aside",
  "table",
  "td",
  "th",
  "ul",
  "ol",
  "dl",
  "dt",
  "dd",
  "blockquote",
  "pre",
  "address",
  "figure",
  "figcaption",
  "form",
  "hr",
]);

interface PageLink {
  url: string;
  anchor: string;
}

interface PageContent {
  title: string;
  text: string;
  /** Absolute url + anchor text; mailto/tel/javascript/fragment hrefs excluded. */
  links: PageLink[];
  /** Addresses declared in mailto: hrefs, decoded, query-stripped, order kept, duplicates kept. */
  mailtos: string[];
  tels: string[];
}

/** HTML character references to text (the WHATWG table). */
export const decodeEntities = decodeHtml;

/** Absolute URL for a link, or the raw href when neither it nor the base parses. */
function joinUrl(base: string, href: string): string {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) return href;
  if (!base) return href;
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
}

class Extractor {
  readonly parts: string[] = [];
  readonly links: PageLink[] = [];
  readonly mailtos: string[] = [];
  readonly tels: string[] = [];
  title = "";
  private skipDepth = 0;
  private inTitle = false;
  private href: string | null = null;
  private anchorParts: string[] = [];

  constructor(private readonly baseUrl: string) {}

  startTag(tag: string, attrs: Readonly<Record<string, string>>): void {
    if (SKIP_CONTENT.has(tag)) this.skipDepth++;
    else if (tag === "title") this.inTitle = true;
    else if (tag === "a") {
      const href = attrs.href;
      if (href?.startsWith("mailto:")) {
        const list = safeDecode(href.slice(7).split("?", 1)[0] ?? "");
        for (const addr of list.split(",")) {
          const clean = addr.trim();
          if (clean) this.mailtos.push(clean);
        }
      } else if (href?.startsWith("tel:")) {
        const number = href.slice(4).trim();
        if (number) this.tels.push(safeDecode(number));
      } else if (href && !href.startsWith("javascript:") && !href.startsWith("#")) {
        this.href = joinUrl(this.baseUrl, href);
        this.anchorParts = [];
      }
    }
    if (BLOCK.has(tag)) this.parts.push("\n");
  }

  endTag(tag: string): void {
    if (SKIP_CONTENT.has(tag) && this.skipDepth) this.skipDepth--;
    else if (tag === "title") this.inTitle = false;
    else if (tag === "a" && this.href) {
      this.links.push({
        url: this.href,
        anchor: this.anchorParts.join("").split(/\s+/).filter(Boolean).join(" "),
      });
      this.href = null;
    }
    if (BLOCK.has(tag)) this.parts.push("\n");
  }

  /** Text as the parser hands it: entities already decoded once. */
  data(decoded: string): void {
    const text = decoded.replaceAll("\u00a0", " ");
    // The page's title, never words of the body.
    if (this.inTitle) {
      this.title += text;
      return;
    }
    if (this.skipDepth) return;
    this.parts.push(text);
    if (this.href !== null) this.anchorParts.push(text);
  }
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function readPage(html: string, baseUrl = ""): PageContent {
  const out = new Extractor(baseUrl);
  try {
    const parser = new Parser({
      onopentag: (name, attrs) => out.startTag(name, attrs),
      onclosetag: (name) => out.endTag(name),
      ontext: (text) => out.data(text),
    });
    parser.write(html);
    parser.end();
  } catch {
    // degrade to whatever was extracted so far
  }
  const text = out.parts
    .join("")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  return {
    title: out.title.split(/\s+/).filter(Boolean).join(" "),
    text,
    links: out.links,
    mailtos: out.mailtos,
    tels: out.tels,
  };
}

/** SPA mount-point / framework markers, checked against lowercased markup. */
const SHELL_MARKERS = [
  'id="root"',
  "id='root'",
  'id="app"',
  "id='app'",
  'id="__next"',
  "__next_data__",
  "data-reactroot",
  'id="___gatsby"',
  "ng-version=",
  'id="q-app"',
  "enable javascript",
  "requires javascript",
] as const;
const SHELL_MAX_TEXT = 200;
const SHELL_MIN_HTML = 2000;

/**
 * Is this page a JS mount point whose words live client-side? Thin text alone must
 * NOT fire (a tiny server-rendered contact page is real content): a shell is thin
 * text plus substantial, script-dominated markup or a framework mount marker.
 */
export function looksLikeJsShell(html: string, text: string): boolean {
  if (text.trim().length >= SHELL_MAX_TEXT) return false;
  if (html.length < SHELL_MIN_HTML) return false;
  const lowered = html.toLowerCase();
  if (SHELL_MARKERS.some((marker) => lowered.includes(marker))) return true;
  return lowered.split("<script").length - 1 >= 3;
}
