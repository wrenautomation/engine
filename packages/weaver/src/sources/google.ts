/**
 * Google's own page through the desk's browser (`web GET /google`): each organic result as a
 * hit, and the AI Overview as one hit of its own. The Overview is a claim, never a proof: its
 * text and the questions people also ask ride in that hit's snippet; each page it cites becomes
 * a hit, so the proof comes from reading those. A captcha or a spent cap is a miss.
 */
import type { HitViewIn } from "@wrenautomation/raven";
import type { Source } from "../engine/ports.js";
import type { LadderClient } from "../fetch/ladder.js";
import { routeCall } from "./sites.js";

interface Serp {
  overview?: { text?: string; sources?: { title?: string; url?: string | null }[] } | null;
  results?: {
    title?: string;
    url?: string | null;
    snippet?: string | null;
    date?: string | null;
  }[];
  questions?: string[];
}

/** Google's printed date ("Aug 21, 2026") as an ISO day; nothing when it is not one. */
const isoDay = (d: string | null | undefined): string | undefined => {
  if (!d) return undefined;
  const t = Date.parse(d);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString().slice(0, 10);
};

/** The Overview's hit: Google's search URL for the terms, its fragment naming it. */
export const overviewUrl = (terms: string) =>
  `https://www.google.com/search?q=${encodeURIComponent(terms)}#ai-overview`;

export function serpHits(body: unknown, terms: string): HitViewIn[] {
  const serp = (body ?? {}) as Serp;
  const out: HitViewIn[] = [];
  for (const r of serp.results ?? []) {
    if (!r.url) continue;
    const date = isoDay(r.date);
    out.push({
      url: r.url,
      ...(r.title ? { title: r.title } : {}),
      ...(r.snippet ? { snippet: r.snippet } : {}),
      ...(date ? { date } : {}),
    });
  }
  const o = serp.overview;
  if (o?.text?.trim()) {
    const asked = serp.questions?.length
      ? `\n\nPeople also ask: ${serp.questions.join(" | ")}`
      : "";
    out.push({
      url: overviewUrl(terms),
      title: `Google AI Overview: ${terms}`,
      channel: "Google AI Overview",
      snippet: `${o.text.trim()}${asked}`,
    });
    for (const s of o.sources ?? [])
      if (s.url)
        out.push({
          url: s.url,
          ...(s.title ? { title: s.title } : {}),
          snippet: "Cited by Google's AI Overview",
        });
  }
  return out;
}

export function googleSource(o: { sites: LadderClient; n?: number }): Source {
  return {
    name: "google",
    kind: "search",
    cost: "browser",
    async search(q) {
      const terms = q.site ? `${q.terms} site:${q.site}` : q.terms;
      const body = await routeCall(o.sites, "google", "web", "/google", { q: terms, n: o.n ?? 10 });
      return serpHits(body, terms);
    },
  };
}
