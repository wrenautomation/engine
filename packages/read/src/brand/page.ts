/**
 * Brand votes from a page's HTML (htmlparser2, one pass): the logo (an image or inline SVG in the
 * header or the home link, by its name), favicons, the theme colour, Google Fonts, and the CSS to
 * read next (`<link rel=stylesheet>`, `<style>`, inline styles of body and buttons).
 */
import { Parser } from "htmlparser2";
import { abs, chromatic, hexOf, type Votes } from "./votes.js";

export interface PageRead {
  /** Stylesheet URLs, in page order. */
  sheets: string[];
  /** `<style>` blocks and inline styles as rules. */
  css: string[];
}

const TOP = /(^|[\s_-])(header|masthead|navbar|topbar|site-header|nav)([\s_-]|$)/i;
const LOGO = /logo|brand/i;
const SVG_MAX = 60_000;
const FONT_HOSTS = /fonts\.googleapis\.com|use\.typekit\.net|fonts\.bunny\.net/;

/** Families a Google Fonts or Bunny link loads: `family=Inter:wght@400|Playfair+Display`. */
function familiesOf(href: string): string[] {
  try {
    const u = new URL(href);
    return u.searchParams
      .getAll("family")
      .flatMap((f) => f.split("|"))
      .map((f) => f.split(":")[0]?.replace(/\+/g, " ").trim() ?? "")
      .filter(Boolean);
  } catch {
    return [];
  }
}

const homeOf = (href: string | undefined, base: string): boolean => {
  const u = abs(href, base);
  if (!u) return false;
  const a = new URL(u);
  return a.host === new URL(base).host && (a.pathname === "/" || a.pathname === "");
};

/** Read one page into `v`; returns the CSS to read next. */
export function readPage(html: string, url: string, v: Votes): PageRead {
  let base = url;
  const sheets: string[] = [];
  const css: string[] = [];
  const stack: { name: string; top: boolean; home: boolean }[] = [];
  let top = 0;
  let home = 0;
  let style: string[] | null = null;
  let svg: { start: number; depth: number; w: number } | null = null;
  let svgDepth = 0;

  const parser = new Parser(
    {
      onopentag(name, a) {
        const hint = `${a.class ?? ""} ${a.id ?? ""} ${a.role ?? ""}`;
        const isTop = name === "header" || name === "nav" || TOP.test(hint);
        const isHome = name === "a" && homeOf(a.href, base);
        stack.push({ name, top: isTop, home: isHome });
        if (isTop) top++;
        if (isHome) home++;
        if (name === "base" && a.href) base = abs(a.href, url) ?? base;
        if (name === "style") style = [];
        if (name === "svg") {
          svgDepth++;
          const named = LOGO.test(`${hint} ${a["aria-label"] ?? ""}`);
          const w = named && (top || home) ? 0.9 : named ? 0.75 : home && top ? 0.7 : 0;
          if (svgDepth === 1 && w) svg = { start: parser.startIndex, depth: 1, w };
        }
        if (name === "img") {
          const src = abs(a.src ?? a["data-src"] ?? a.srcset?.split(/\s+/)[0], base);
          if (!src || /^data:image\/gif/.test(src)) return;
          const named = LOGO.test(`${hint} ${a.alt ?? ""} ${src.split("?")[0]}`);
          const w = named && (top || home) ? 0.95 : named ? 0.7 : home && top ? 0.6 : 0;
          if (w) v.logos.push({ url: src, kind: "img", w });
        }
        if (name === "link") {
          const rel = (a.rel ?? "").toLowerCase().split(/\s+/);
          const href = abs(a.href, base);
          if (!href) return;
          if (FONT_HOSTS.test(href)) {
            for (const family of familiesOf(href)) v.fonts.push({ role: "any", family, w: 0.4 });
            return;
          }
          const sheet = rel.includes("stylesheet") || (rel.includes("preload") && a.as === "style");
          if (sheet && !/print/.test(a.media ?? "")) sheets.push(href);
          if (rel.includes("apple-touch-icon")) v.logos.push({ url: href, kind: "icon", w: 0.35 });
          else if (rel.includes("icon") || rel.includes("mask-icon"))
            v.logos.push({
              url: href,
              kind: "icon",
              w: a.type === "image/svg+xml" || /\.svg($|\?)/.test(href) ? 0.4 : 0.25,
            });
          const mask = rel.includes("mask-icon") && a.color ? hexOf(a.color) : null;
          if (mask && chromatic(mask)) v.colors.push({ role: "primary", hex: mask, w: 0.4 });
        }
        if (name === "meta") {
          const key = (a.name ?? a.property ?? "").toLowerCase();
          if (key === "theme-color" && !a.media?.includes("dark")) {
            const hex = a.content ? hexOf(a.content) : null;
            if (hex && chromatic(hex)) v.colors.push({ role: "primary", hex, w: 0.5 });
            else if (hex) v.colors.push({ role: "background", hex, w: 0.3 });
          }
          if (key === "og:image") {
            const img = abs(a.content, base);
            if (img) v.logos.push({ url: img, kind: "og", w: 0.1 });
          }
        }
        if (a.style && (name === "body" || name === "html")) css.push(`body{${a.style}}`);
        else if (a.style && (name === "button" || /\b(btn|button|cta)\b/i.test(hint)))
          css.push(`.btn{${a.style}}`);
      },
      ontext(text) {
        if (style) style.push(text);
      },
      onclosetag(name) {
        if (name === "style" && style) {
          css.push(style.join(""));
          style = null;
        }
        if (name === "svg") {
          if (svg && svgDepth === 1) {
            const markup = html.slice(svg.start, parser.endIndex + 1);
            if (markup.length > 80 && markup.length < SVG_MAX)
              v.logos.push({
                url: `data:image/svg+xml;base64,${Buffer.from(markup).toString("base64")}`,
                kind: "svg",
                w: svg.w,
              });
            svg = null;
          }
          svgDepth = Math.max(0, svgDepth - 1);
        }
        // implied closes: pop to the tag that closed
        const at = stack.map((s) => s.name).lastIndexOf(name);
        if (at < 0) return;
        for (const s of stack.splice(at)) {
          if (s.top) top--;
          if (s.home) home--;
        }
      },
    },
    { decodeEntities: true, lowerCaseAttributeNames: true },
  );
  try {
    parser.write(html);
    parser.end();
  } catch {
    // a broken page keeps what was read
  }
  return { sheets, css };
}
