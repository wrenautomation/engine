/**
 * Evidence for a brand: each colour, font and logo a page or a browser shows, with a weight for how
 * directly it names the brand. Every reader (HTML, CSS, a browser's computed styles) writes votes;
 * `score` alone decides.
 */
import { colorsNamed, differenceEuclidean, formatHex, oklch, parse } from "culori";

export type ColorRole = "primary" | "accent" | "background" | "text" | "any";
export type FontRole = "heading" | "body" | "any";
/** `svg`: inline in the page (a data URI); `img`: an image tag; `icon`: a favicon; `og`: the share image. */
export type LogoKind = "svg" | "img" | "icon" | "og";

export interface Votes {
  colors: { role: ColorRole; hex: string; w: number }[];
  fonts: { role: FontRole; family: string; w: number }[];
  logos: { url: string; kind: LogoKind; w: number }[];
}

export const votesOf = (): Votes => ({ colors: [], fonts: [], logos: [] });

/** One CSS colour as #rrggbb; null for see-through (alpha under 0.5) or not a colour. */
export function hexOf(value: string): string | null {
  const c = parse(value.trim());
  if (!c || (c.alpha ?? 1) < 0.5) return null;
  return formatHex(c) ?? null;
}

const NAMED = new Set(Object.keys(colorsNamed));
const TOKEN =
  /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()]*\)|\b[a-z]{3,20}\b/gi;

/** Every colour in a declaration's value: `1px solid #ccc`, a gradient's stops. */
export function colorsIn(value: string): string[] {
  const out: string[] = [];
  for (const [t] of value.matchAll(TOKEN)) {
    if (/^[a-z]+$/i.test(t) && !NAMED.has(t.toLowerCase())) continue;
    const hex = hexOf(t);
    if (hex) out.push(hex);
  }
  return out;
}

/** Has hue: not a grey, not near white or black. A brand's primary is one. */
export function chromatic(hex: string): boolean {
  const c = oklch(hex);
  return !!c && (c.c ?? 0) > 0.05 && c.l > 0.15 && c.l < 0.96;
}

const distance = differenceEuclidean("oklab");
/** Two colours a reader tells apart. */
export const apart = (a: string, b: string) => distance(a, b) > 0.08;

const GENERIC = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-sans-serif",
  "ui-serif",
  "ui-monospace",
  "ui-rounded",
  "-apple-system",
  "blinkmacsystemfont",
  "inherit",
  "initial",
  "unset",
  "revert",
  "emoji",
  "math",
  "fangsong",
  "apple color emoji",
  "segoe ui emoji",
  "segoe ui symbol",
  "noto color emoji",
]);
const ICON_FONT =
  /icon|awesome|glyph|material symbols|dashicons|eicons|swiper|slick|fontello|feather|lucide/i;
/** `font: 600 16px/1.5 Inter, sans-serif`: the families after the size. */
const SHORTHAND = /(?:^|\s)[\d.]+(?:px|r?em|%|pt|vw|vh|ch)(?:\s*\/\s*\S+)?\s+(.+)$/;

/** The first named family of a `font-family` or `font` value; null for generic or icon stacks. */
export function fontOf(value: string, shorthand = false): string | null {
  let list = value.replace(/!important/i, "");
  if (shorthand) {
    const m = list.match(SHORTHAND);
    if (!m?.[1]) return null;
    list = m[1];
  }
  for (const raw of list.split(",")) {
    const name = raw
      .trim()
      .replace(/^["']|["']$/g, "")
      .trim();
    if (!name || name.includes("(")) continue;
    if (GENERIC.has(name.toLowerCase())) continue;
    return ICON_FONT.test(name) ? null : name;
  }
  return null;
}

/** An href against the page; only http(s) and data images. */
export function abs(href: string | undefined, base: string): string | null {
  if (!href) return null;
  try {
    const u = new URL(href.trim(), base);
    if (u.protocol === "http:" || u.protocol === "https:") return u.href;
    return u.protocol === "data:" && /^data:image\/(svg|png|webp|jpe?g)/i.test(u.href)
      ? u.href
      : null;
  } catch {
    return null;
  }
}
