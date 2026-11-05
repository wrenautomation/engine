/**
 * Brand votes from CSS (postcss): custom properties on the root by name (`--primary`, `--font-heading`),
 * then body, headings, buttons and links by selector, then every colour and family by count.
 * Dark-mode and print rules are skipped: the page as most first see it.
 */
import postcss, { type AtRule, type Container, type Root } from "postcss";
import { chromatic, colorsIn, fontOf, hexOf, type Votes } from "./votes.js";

const ROOT = /^(:root|html|body|:host|\[data-theme=["']?light["']?\]|\.light)$/;
const BODY = /^(html|body|:root)$/;
const HEAD = /(^|\s)(h1|h2|h3|\.h1|\.h2|\.heading|\.display|\.title)([.:[\s]|$)/;
const BUTTON = /(^|[\s.#[_-])(btn|button|cta)([\s.:[#_-]|$)/;
const BUTTON_NOT =
  /:hover|:focus|:active|:disabled|disabled|outline|secondary|ghost|link|close|toggle|light|white|dark|transparent|text|components-|wp-admin|admin-bar/;
const LINK = /^a(:link|:visited)?$/;
const DARK = /prefers-color-scheme:\s*dark|print/;
const DARK_SEL = /\.dark\b|data-theme=["']?dark|\.theme-dark|data-bs-theme=["']?dark/;

/** One stylesheet's tree; a sheet postcss cannot read gives none. */
export function parseSheet(css: string): Root | null {
  try {
    return postcss.parse(css);
  } catch {
    return null;
  }
}

/** `@import` targets of a sheet, for one more level of fetches. */
export function importsOf(root: Root): string[] {
  const out: string[] = [];
  root.walkAtRules("import", (a) => {
    const m = a.params.match(/url\(\s*["']?([^"')]+)|^["']([^"']+)/);
    const href = m?.[1] ?? m?.[2];
    if (href && !/print/.test(a.params)) out.push(href);
  });
  return out;
}

const hidden = (node: { parent?: Container | undefined }): boolean => {
  for (let p = node.parent; p; p = p.parent as Container | undefined) {
    if (p.type === "atrule" && DARK.test((p as AtRule).params)) return true;
    if (p.type === "rule" && DARK_SEL.test((p as unknown as { selector: string }).selector))
      return true;
  }
  return false;
};

const selectorsOf = (node: { parent?: Container | undefined }): string[] =>
  node.parent?.type === "rule"
    ? (node.parent as unknown as { selector: string }).selector
        .toLowerCase()
        .split(",")
        .map((s) => s.trim())
    : [];

/** Root custom properties across every sheet; the first one set wins, as on a light page. */
export function varsOf(roots: readonly Root[]): Map<string, string> {
  const vars = new Map<string, string>();
  for (const root of roots)
    root.walkDecls(/^--/, (d) => {
      if (hidden(d) || vars.has(d.prop)) return;
      if (selectorsOf(d).some((s) => ROOT.test(s))) vars.set(d.prop, d.value.trim());
    });
  return vars;
}

const VAR = /var\(\s*(--[\w-]+)\s*(?:,\s*((?:[^()]|\([^()]*\))*))?\)/g;
/** `var()` filled from the root, five levels deep. */
export function resolve(value: string, vars: ReadonlyMap<string, string>): string {
  let out = value;
  for (let i = 0; i < 5 && out.includes("var("); i++)
    out = out.replace(
      VAR,
      (_, name: string, fallback?: string) => vars.get(name) ?? fallback ?? "",
    );
  return out;
}

/** A custom property's colour: a colour, or bare HSL channels as shadcn sets (`221 83% 53%`). */
const varColor = (v: string): string | null =>
  hexOf(v) ?? (/^[\d.]+(deg)?\s+[\d.]+%\s+[\d.]+%$/.test(v) ? hexOf(`hsl(${v})`) : null);

/** Palette names only under a bare name or a theme's own prefix: design systems name hundreds of roles. */
const NS =
  "(?:(?:color|colors|clr|c|bs|theme|site|global|brand|wp--preset--color-|chakra-colors|mantine-color|md-sys-color|ifm-color)-)?";
const VAR_ROLES: [RegExp, Votes["colors"][number]["role"], number][] = [
  [new RegExp(`^--${NS}(primary|brand|main)(-color)?$`), "primary", 0.6],
  [new RegExp(`^--${NS}(accent|secondary)(-color)?$`), "accent", 0.45],
  [new RegExp(`^--${NS}(background|bg|body-bg|page-bg)(-color)?$`), "background", 0.5],
  [new RegExp(`^--${NS}(foreground|text|body-color|fg|ink)(-color)?$`), "text", 0.5],
];
const FONT_VARS: [RegExp, Votes["fonts"][number]["role"]][] = [
  [
    /^--([\w-]*-)?font-?(heading|display|title|headings)$|^--([\w-]*-)?(heading|display)-font$/,
    "heading",
  ],
  [/^--([\w-]*-)?font-?(sans|body|base|text|primary)$|^--([\w-]*-)?(body|base)-font$/, "body"],
];

/** Votes from the root's custom properties, by their names. */
export function voteVars(vars: ReadonlyMap<string, string>, v: Votes): void {
  for (const [name, raw] of vars) {
    const value = resolve(raw, vars);
    const fr = FONT_VARS.find(([re]) => re.test(name));
    if (fr) {
      const family = fontOf(value);
      if (family) v.fonts.push({ role: fr[1], family, w: 0.5 });
      continue;
    }
    const hit = VAR_ROLES.find(([re]) => re.test(name));
    const hex = hit ? varColor(value) : null;
    if (!hit || !hex) continue;
    const [, role, w] = hit;
    if ((role === "primary" || role === "accent") && !chromatic(hex)) continue;
    v.colors.push({ role, hex, w });
  }
}

/** Votes from one sheet's rules, `var()` filled. `@font-face` families count as chosen fonts. */
export function voteSheet(root: Root, vars: ReadonlyMap<string, string>, v: Votes): void {
  root.walkAtRules("font-face", (a) => {
    a.walkDecls("font-family", (d) => {
      const family = fontOf(d.value);
      if (family) v.fonts.push({ role: "any", family, w: 0.15 });
    });
  });
  root.walkDecls((d) => {
    if (d.prop.startsWith("--") || hidden(d) || d.parent?.type !== "rule") return;
    const prop = d.prop.toLowerCase();
    const value = resolve(d.value, vars);
    const sels = selectorsOf(d);
    const body = sels.some((s) => BODY.test(s));
    const head = sels.some((s) => HEAD.test(s));
    const button = sels.some((s) => BUTTON.test(s) && !BUTTON_NOT.test(s));
    const link = sels.some((s) => LINK.test(s));
    if (prop === "font-family" || prop === "font") {
      const family = fontOf(value, prop === "font");
      if (!family) return;
      if (body) v.fonts.push({ role: "body", family, w: 0.8 });
      if (head) v.fonts.push({ role: "heading", family, w: 0.7 });
      v.fonts.push({ role: "any", family, w: 0.05 });
      return;
    }
    const colors = colorsIn(value);
    const [first] = colors;
    if (!first) return;
    const bg = prop === "background" || prop === "background-color";
    if (bg && body) v.colors.push({ role: "background", hex: first, w: 0.7 });
    if (prop === "color" && body) v.colors.push({ role: "text", hex: first, w: 0.7 });
    if (prop === "color" && head) v.colors.push({ role: "text", hex: first, w: 0.2 });
    if (bg && button) v.colors.push({ role: "primary", hex: first, w: 0.5 });
    if (prop === "color" && link && chromatic(first))
      v.colors.push({ role: "accent", hex: first, w: 0.35 });
    for (const hex of colors) v.colors.push({ role: "any", hex, w: 0.03 });
  });
}
