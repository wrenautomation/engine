/**
 * A study as markdown: each angle's claims with [n] marks and the reader's calls, the
 * drafts that cite them, then every source once. Pure: the caller reads, this writes.
 */
import type { DraftItem, DroppedDraft, NumberedClaim, StudyDraftSpec } from "./drafts.js";

/** A claim as the report sees it: numbered, with the reader's call on it. */
export interface ReportClaim extends NumberedClaim {
  /** keep, tune or drop; null when nobody has called it. */
  call: string | null;
  comment: string | null;
}

export interface ReportAngle {
  angle: string;
  claims: readonly ReportClaim[];
}

export interface ReportDraft {
  spec: StudyDraftSpec;
  done: boolean;
  /** Calls or new claims changed its claims since it was written. */
  stale: boolean;
  kept: readonly DraftItem[];
  dropped: readonly DroppedDraft[];
}

/** A page someone added by hand, not found by a search. */
export interface ReportManualPage {
  by: string;
  at: string;
  /** YYYY-MM-DD, when given. */
  published: string | null;
}

/** What the report needs of a study; a richer view satisfies it. */
export interface StudyReportView {
  study: { question: string; slug: string; niche?: string | null };
  angles: readonly ReportAngle[];
  drafts: readonly ReportDraft[];
  /** Page title by source url. */
  titles: ReadonlyMap<string, string>;
  manual?: ReadonlyMap<string, ReportManualPage> | null;
  counts: { queries: number; pages: number; unread: number; gated: number; waiting: number };
}

export interface ReportOptions {
  /** The command that runs the open parts, shown when some are still to run. */
  rerun?: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function studyReport(view: StudyReportView, opts: ReportOptions = {}): string {
  const { study, angles, drafts, titles, manual, counts } = view;
  const rerun = opts.rerun ? `: \`${opts.rerun}\`` : "";
  const claims = angles.flatMap((a) => a.claims);
  const dropped = claims.filter((c) => c.call === "drop").length;
  const open = counts.waiting + drafts.filter((d) => !d.done || d.stale).length;
  const out: string[] = [
    `# ${study.question}`,
    "",
    `Study \`${study.slug}\`${study.niche ? ` for ${study.niche}` : ""}. ${plural(counts.queries, "search", "searches")}, ${plural(counts.pages, "page")} read (${counts.unread} unreadable), ${plural(claims.length, "claim")} passed the quote check (${counts.gated} did not), ${dropped} dropped by you.${open ? ` ${plural(open, "part")} still to run${rerun}.` : ""}`,
  ];

  for (const a of angles) {
    out.push("", `## ${a.angle}`, "");
    if (!a.claims.length)
      out.push(
        counts.waiting || !counts.pages
          ? "_Not run yet._"
          : "_Nothing on the pages read answered this._",
      );
    for (const c of a.claims) {
      const call = c.call ? ` (${c.call}${c.comment ? `: ${c.comment}` : ""})` : "";
      const line = `${c.claim} [${c.n}]${call}`;
      out.push(c.call === "drop" ? `- ~~${line}~~` : `- ${line}`);
    }
  }

  for (const d of drafts) {
    out.push("", `## Draft: ${d.spec.key}`, "");
    if (!d.done) out.push("_Not run yet._");
    else if (d.stale) out.push(`_Your calls or new claims changed its claims${rerun}._`, "");
    if (d.done && !d.kept.length) out.push("_Nothing survived the citation check._");
    for (const item of d.kept) {
      out.push(
        `### ${item.title || "(untitled)"}`,
        "",
        item.body,
        "",
        `Cites ${item.cites.map((n) => `[${n}]`).join(" ")}`,
        "",
      );
    }
    if (d.dropped.length) {
      out.push(
        `_Dropped: ${d.dropped.map((x) => `${x.title || "(untitled)"} (${x.why.replace(/_/g, " ")})`).join("; ")}._`,
      );
    }
  }

  if (claims.length) {
    out.push("", "## Sources", "");
    for (const c of claims) {
      const title = titles.get(c.source_url);
      const m = manual?.get(c.source_url);
      const held = m
        ? ` (added by hand by ${m.by} on ${m.at.slice(0, 10)}${m.published ? `, published ${m.published}` : ""})`
        : "";
      out.push(`${c.n}. ${title ? `${title}, ` : ""}<${c.source_url}>${held}: "${c.quote}"`);
    }
  }
  return `${out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()}\n`;
}
