/**
 * Votes to a brand. Per role, the value with the most weight wins. Confidence is how much evidence
 * the winner has (capped at 1) times its share of its role. Primary and accent must have hue and
 * differ; with no role votes they fall back to the most used hued colours.
 */
import {
  apart,
  type ColorRole,
  chromatic,
  type FontRole,
  type LogoKind,
  type Votes,
} from "./votes.js";

export interface Scored {
  logo: { url: string; kind: LogoKind } | null;
  palette: {
    primary: string | null;
    accent: string | null;
    background: string | null;
    text: string | null;
  };
  fonts: { heading: string | null; body: string | null };
  /** 0 to 1 each. */
  confidence: { logo: number; palette: number; fonts: number };
}

type Ranked = { value: string; w: number; conf: number }[];

function rank<T extends { w: number }>(items: readonly T[], key: (t: T) => string): Ranked {
  const sums = new Map<string, number>();
  let total = 0;
  for (const t of items) {
    const k = key(t);
    sums.set(k, (sums.get(k) ?? 0) + t.w);
    total += t.w;
  }
  return [...sums]
    .map(([value, w]) => ({ value, w, conf: Math.min(1, w) * (total ? w / total : 0) }))
    .sort((a, b) => b.w - a.w);
}

const colors = (v: Votes, role: ColorRole) =>
  rank(
    v.colors.filter((c) => c.role === role),
    (c) => c.hex,
  );
const fonts = (v: Votes, role: FontRole) =>
  rank(
    v.fonts.filter((f) => f.role === role),
    (f) => f.family.toLowerCase(),
  );

/** Shown names keep the page's casing: the first spelling seen. */
const spelled = (v: Votes, lower: string | undefined) =>
  lower ? (v.fonts.find((f) => f.family.toLowerCase() === lower)?.family ?? lower) : null;

const round = (n: number) => Math.round(n * 100) / 100;

export function score(v: Votes): Scored {
  const background = colors(v, "background")[0] ?? null;
  // an unset page background is the browser's white
  const ground = background?.value ?? "#ffffff";
  const text = colors(v, "text").find((c) => apart(c.value, ground)) ?? null;
  // counted colours: a weak fallback, so their confidence is cut
  const hued = colors(v, "any")
    .filter((c) => chromatic(c.value))
    .map((c) => ({ ...c, conf: c.conf * 0.5 }));
  const ok = (c: { value: string }) => apart(c.value, ground);
  const primary = [...colors(v, "primary"), ...hued].find(ok) ?? null;
  const notPrimary = (c: { value: string }) => ok(c) && (!primary || apart(c.value, primary.value));
  const accent =
    [...colors(v, "accent"), ...colors(v, "primary"), ...hued]
      .filter(chromaticOf)
      .find(notPrimary) ?? null;

  const body = fonts(v, "body")[0] ?? fonts(v, "any")[0] ?? null;
  const heading = fonts(v, "heading")[0] ?? body;
  const logo =
    [...v.logos].sort((a, b) => b.w - a.w || kindRank(a.kind) - kindRank(b.kind))[0] ?? null;

  const conf = (c: { conf: number } | null) => c?.conf ?? 0;
  return {
    logo: logo ? { url: logo.url, kind: logo.kind } : null,
    palette: {
      primary: primary?.value ?? null,
      accent: accent?.value ?? null,
      background: background?.value ?? null,
      text: text?.value ?? null,
    },
    fonts: { heading: spelled(v, heading?.value), body: spelled(v, body?.value) },
    confidence: {
      logo: round(logo?.w ?? 0),
      palette: round(
        0.6 * conf(primary) + 0.15 * conf(background) + 0.15 * conf(text) + 0.1 * conf(accent),
      ),
      fonts: round(0.6 * conf(body) + 0.4 * conf(heading)),
    },
  };
}

const chromaticOf = (c: { value: string }) => chromatic(c.value);
const kindRank = (k: LogoKind) => ["svg", "img", "icon", "og"].indexOf(k);

/** Thin: worth a browser. No logo or a weak one, no hued primary, or no body font. */
export const thin = (s: Scored): boolean =>
  s.confidence.logo < 0.5 || !s.palette.primary || s.confidence.palette < 0.3 || !s.fonts.body;
