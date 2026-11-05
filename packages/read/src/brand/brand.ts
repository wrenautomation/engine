/**
 * A site's brand: logo, palette and fonts (WA-1094; the shape follows ScrapeGraphAI's `branding`).
 * Static first: the page and its stylesheets by plain HTTP. Thin (`thin`) and a ladder at hand: a
 * browser's computed styles (`web GET /brand`); that route absent, the ladder's render rung's HTML.
 * No model. Decision log: wren designs/2026-10-26-research-engine.md, 11-05 brand.
 */
import type { Fetcher } from "../fetch/fetcher.js";
import { fetchLadder, type LadderClient } from "../fetch/ladder.js";
import { readPage } from "./page.js";
import { type Scored, score, thin } from "./score.js";
import { importsOf, parseSheet, varsOf, voteSheet, voteVars } from "./sheet.js";
import { abs, apart, chromatic, fontOf, hexOf, type Votes, votesOf } from "./votes.js";

/** `static`: plain HTTP; `ladder`: the page came up the ladder; `render`: a rendered page's HTML; `browser`: computed styles. */
export type BrandSource = "static" | "ladder" | "render" | "browser";

export interface Brand extends Scored {
  /** The page read, after redirects. */
  url: string;
  from: BrandSource[];
  /** Stylesheets read. */
  sheets: number;
}

/**
 * What `web GET /brand` answers: one page's computed styles in a browser, light scheme.
 * Colours as the browser gives them (`rgb(…)`); fonts as `font-family` lists.
 */
export interface BrandProbe {
  finalUrl: string;
  status: number | null;
  /** null: a usable page; else the block the browser still met. */
  block: string | null;
  themeColor: string | null;
  body: { background: string; color: string; font: string };
  /** Visible h1 and h2, first 6. */
  headings: { font: string; color: string }[];
  /** Visible buttons and button-like links with a fill, first 20; `area` in px². */
  buttons: { background: string; color: string; area: number }[];
  /** Visible links' text colours, first 30. */
  links: { color: string }[];
  /** Images and SVGs named logo or brand, or in the home link; `svg` is the markup. */
  logos: { src: string | null; svg: string | null; named: boolean; top: boolean; area: number }[];
}

export interface BrandDeps {
  fetcher: Fetcher;
  /** autobrowse's site client: the ladder and `web GET /brand`. Absent: static only. */
  sites?: LadderClient | undefined;
  /** Stylesheets to read, `@import`s included. Default 8. */
  sheets?: number | undefined;
}

const SHEET_MAX = 2_000_000;

/** Votes from a page and its stylesheets; `cache` keeps sheets across passes. */
async function readStatic(
  html: string,
  url: string,
  d: BrandDeps,
  cache: Map<string, string | null>,
): Promise<Votes> {
  const v = votesOf();
  const page = readPage(html, url, v);
  const cap = d.sheets ?? 8;
  const get = (href: string) =>
    d.fetcher
      .get(href)
      .then((r) => (r.status < 400 ? r.text.slice(0, SHEET_MAX) : null))
      .catch(() => null);
  const fetchAll = async (hrefs: string[]) => {
    const fresh = hrefs.filter((h) => !cache.has(h)).slice(0, Math.max(0, cap - cache.size));
    const got = await Promise.all(fresh.map(get));
    for (const [i, h] of fresh.entries()) cache.set(h, got[i] ?? null);
  };
  await fetchAll(page.sheets);
  const roots = [...page.sheets, ...page.css].flatMap((s, i) => {
    const text = i < page.sheets.length ? cache.get(s) : s;
    const root = text ? parseSheet(text) : null;
    return root ? [{ root, href: i < page.sheets.length ? s : url }] : [];
  });
  const imports = roots.flatMap(({ root, href }) =>
    importsOf(root).flatMap((i) => abs(i, href) ?? []),
  );
  if (imports.length) {
    await fetchAll(imports);
    for (const h of imports) {
      const root = cache.get(h) ? parseSheet(cache.get(h) as string) : null;
      if (root) roots.push({ root, href: h });
    }
  }
  const trees = roots.map((r) => r.root);
  const vars = varsOf(trees);
  voteVars(vars, v);
  for (const t of trees) voteSheet(t, vars, v);
  return v;
}

/** Computed styles as votes: what a person sees, so they outweigh the CSS. */
export function voteProbe(p: BrandProbe, v: Votes): void {
  const bg = hexOf(p.body.background);
  const ink = hexOf(p.body.color);
  if (bg) v.colors.push({ role: "background", hex: bg, w: 0.9 });
  if (ink) v.colors.push({ role: "text", hex: ink, w: 0.9 });
  const body = fontOf(p.body.font);
  if (body) v.fonts.push({ role: "body", family: body, w: 0.9 });
  for (const h of p.headings) {
    const family = fontOf(h.font);
    if (family) v.fonts.push({ role: "heading", family, w: 0.85 / p.headings.length });
  }
  const theme = p.themeColor ? hexOf(p.themeColor) : null;
  if (theme && chromatic(theme)) v.colors.push({ role: "primary", hex: theme, w: 0.4 });
  const filled = p.buttons.flatMap((b) => {
    const hex = hexOf(b.background);
    return hex && (!bg || apart(hex, bg)) ? [{ hex, area: Math.max(1, b.area) }] : [];
  });
  const area = filled.reduce((s, b) => s + b.area, 0);
  for (const b of filled) v.colors.push({ role: "primary", hex: b.hex, w: (0.8 * b.area) / area });
  const links = p.links.flatMap((l) => {
    const hex = hexOf(l.color);
    return hex && chromatic(hex) ? [hex] : [];
  });
  for (const hex of links) v.colors.push({ role: "accent", hex, w: 0.5 / links.length });
  for (const l of p.logos) {
    const url = l.svg
      ? `data:image/svg+xml;base64,${Buffer.from(l.svg).toString("base64")}`
      : abs(l.src ?? undefined, p.finalUrl);
    const w = l.named && l.top ? 0.97 : l.named ? 0.8 : l.top ? 0.65 : 0;
    if (url && w) v.logos.push({ url, kind: l.svg ? "svg" : "img", w });
  }
}

/** One site's brand. Never throws: a page that cannot be read gives an empty brand. */
export async function brandOf(url: string, d: BrandDeps): Promise<Brand> {
  const from: BrandSource[] = [];
  const cache = new Map<string, string | null>();
  let at = url;
  let html: string | null = null;
  const page = await d.fetcher.get(url).catch(() => null);
  if (page && page.status < 400) {
    html = page.text;
    at = page.url;
    from.push("static");
  } else if (d.sites) {
    const l = await fetchLadder(d.sites, url, "impersonate");
    if ("fetched" in l && !l.fetched.block) {
      html = l.fetched.html;
      at = l.fetched.finalUrl;
      from.push("ladder");
    }
  }
  let v = html ? await readStatic(html, at, d, cache) : votesOf();
  let s = score(v);
  if (thin(s) && d.sites) {
    const probe = await d.sites.call<BrandProbe>("web", "GET", "/brand", { url }).catch(() => null);
    if (probe && !probe.block) {
      voteProbe(probe, v);
      at = probe.finalUrl;
      from.push("browser");
    } else {
      const l = await fetchLadder(d.sites, url, "render");
      if ("fetched" in l && !l.fetched.block) {
        // the rendered DOM holds the static page and what scripts added
        v = await readStatic(l.fetched.html, l.fetched.finalUrl, d, cache);
        at = l.fetched.finalUrl;
        from.push("render");
      }
    }
    s = score(v);
  }
  return { ...s, url: at, from, sheets: [...cache.values()].filter((t) => t !== null).length };
}
