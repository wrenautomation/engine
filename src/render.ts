/** Text the prompts take: what is known, what yielded, what a hit shows for free. */
import type { HitView, YieldRow } from "./types.js";

export const lines = (xs: readonly string[], none = "(nothing)"): string =>
  xs.length ? xs.map((x) => `- ${x}`).join("\n") : none;

/** One line per row, the keys it has first: `source=exa channel=... hits=12 reads=4 proposed=9 kept=3`. */
export function renderYield(rows: readonly YieldRow[]): string {
  if (!rows.length) return "(no history yet)";
  return rows
    .map((r) => {
      const who = (["by", "source", "channel", "kind"] as const)
        .filter((k) => r[k] !== undefined)
        .map((k) => `${k}=${r[k]}`);
      return `- ${[...who, `hits=${r.hits}`, `reads=${r.reads}`, `proposed=${r.proposed}`, `kept=${r.kept}`].join(" ")}`;
    })
    .join("\n");
}

const oneLine = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** Numbered, one hit per line, only the fields it has. */
export function renderHits(hits: readonly HitView[]): string {
  return hits
    .map((h, i) => {
      const parts = [h.url];
      if (h.title) parts.push(`title: ${oneLine(h.title, 120)}`);
      if (h.channel) parts.push(`channel: ${h.channel}`);
      if (h.length !== undefined) parts.push(`length: ${Math.round(h.length)}s`);
      if (h.date) parts.push(`date: ${h.date}`);
      if (h.sources.length) parts.push(`sources: ${h.sources.join(",")}`);
      if (h.snippet) parts.push(`snippet: ${oneLine(h.snippet, 240)}`);
      return `${i + 1}. ${parts.join(" | ")}`;
    })
    .join("\n");
}
