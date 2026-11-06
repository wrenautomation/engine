/**
 * The brief in layers, as skills load: the index names each part with what it holds and when to
 * read it; the agent reads a part when it needs it. The index stays one size however long the run
 * (WA-1135). Earlier rounds fold to their edge, patterns and counts; the current round stays raw.
 */
import type { Brief } from "./agent.js";

/** Rows of a long list the index shows. */
export const INDEX_TOP = 15;
/** Rows a part page shows. */
export const PART_PAGE = 100;

interface Part {
  /** What it holds and when to read it: the part's front matter. */
  about: string;
  rows: (b: Brief) => readonly unknown[];
  /** Rows carry a round: a read takes the current round unless asked for another. */
  byRound?: true;
}

const PARTS: Record<string, Part> = {
  findings: {
    about: "kept findings with quote and URL; read to review a round or write patterns",
    rows: (b) => b.findings.kept,
    byRound: true,
  },
  checks: {
    about:
      "each check of a finding: ok or not, and why; read failed ones before you keep a pattern",
    rows: (b) => [...b.checks].sort((x, y) => Number(x.ok) - Number(y.ok)),
  },
  patterns: {
    about: "what several findings say together, with sources per class and unchecked findings",
    rows: (b) => b.patterns,
    byRound: true,
  },
  known: {
    about: "what the ask took as known, one line each; read before you plan a round",
    rows: (b) => b.ask?.known ?? [],
  },
  recalled: {
    about: "what earlier runs found on the ask's words, best first; read before you plan",
    rows: (b) => b.recalled,
  },
  uncalled: {
    about: "hits to keep or drop, with metrics and lift; read to triage",
    rows: (b) => b.hits.uncalled,
  },
  toRead: {
    about: "kept hits not read yet; `open` reads them",
    rows: (b) => b.hits.toRead,
  },
  toExtract: {
    about: "read documents with no findings yet, best first",
    rows: (b) => b.documents.toExtract,
  },
  unclassed: {
    about: "documents with a kept finding and no class, with the judge's guess",
    rows: (b) => b.documents.unclassed,
  },
  verdicts: {
    about: "each document's quality call, and the gap it names",
    rows: (b) => b.verdicts,
  },
  unfollowed: {
    about: "kept pages no follow started from: their author's posts, pages like them",
    rows: (b) => b.unfollowed,
  },
  people: { about: "people across sites, most kept findings first", rows: (b) => b.people },
  authors: {
    about: "each author's usual draw: the base of a hit's lift",
    rows: (b) => b.authors,
  },
  surveys: {
    about: "channel surveys: uploads ranked by views over the channel's median",
    rows: (b) => b.surveys,
  },
  children: { about: "child runs, with what each read and cost", rows: (b) => b.children },
  yield: {
    about: "what each source, agent and kind yielded over every run",
    rows: (b) => b.yield,
  },
};

export const PART_NAMES = Object.keys(PARTS);

const size = (v: unknown) => JSON.stringify(v ?? null).length;
const roundOf = (r: unknown) => (r as { round?: number }).round;

export interface PartHead {
  part: string;
  about: string;
  /** Rows in the index (the first ones), and all of them. */
  shown: number;
  total: number;
  /** Bytes of the whole part: what reading it costs. */
  bytes: number;
  read: string;
}

/** Each round folded to what its review said: the current one stays raw in the parts. */
export interface RoundDigest {
  round: number;
  edge?: { next: string; why: string };
  patterns: string[];
  findings: number;
}

export type BriefIndex = Omit<
  Brief,
  | "findings"
  | "checks"
  | "patterns"
  | "recalled"
  | "hits"
  | "documents"
  | "verdicts"
  | "unfollowed"
  | "people"
  | "authors"
  | "surveys"
  | "children"
  | "yield"
  | "ask"
> & {
  ask: (Omit<NonNullable<Brief["ask"]>, "known"> & { known: number }) | null;
  rounds: RoundDigest[];
  findings: { kept: number; dropped: number; thisRound: number };
  checks: { ok: number; failed: number };
  patterns: Brief["patterns"];
  hits: { read: number; total: number; uncalled: unknown[]; toRead: unknown[] };
  documents: { total: number; toExtract: unknown[]; unclassed: unknown[] };
  people: unknown[];
  surveys: unknown[];
  children: unknown[];
  recalled: unknown[];
  unfollowed: unknown[];
  /** Per source only; the agents' and kinds' rows are in the part. */
  yield: unknown[];
  parts: PartHead[];
};

const head = (b: Brief, part: string, shown: number): PartHead => {
  const rows = PARTS[part]?.rows(b) ?? [];
  return {
    part,
    about: PARTS[part]?.about ?? "",
    shown,
    total: rows.length,
    bytes: size(rows),
    read: `birdwatch brief ${b.run} --part ${part}`,
  };
};

/** The brief's first layer: small fields whole, round digests, each long list's head, the parts. */
export function briefIndex(b: Brief): BriefIndex {
  const top = (part: string, n = INDEX_TOP) => (PARTS[part]?.rows(b) ?? []).slice(0, n);
  const {
    findings,
    checks,
    patterns,
    recalled,
    hits,
    documents,
    verdicts: _v,
    unfollowed: _u,
    people: _p,
    authors: _a,
    surveys: _s,
    children: _c,
    yield: yieldRows,
    ask,
    ...small
  } = b;
  const rounds: RoundDigest[] = [];
  for (let r = 1; r < b.round; r++) {
    const edge = b.edges.findLast((e) => e.round === r);
    rounds.push({
      round: r,
      ...(edge ? { edge: { next: edge.next, why: edge.why } } : {}),
      patterns: patterns.filter((p) => p.round === r).map((p) => p.id),
      findings: findings.kept.filter((f) => f.round === r).length,
    });
  }
  const failed = checks.filter((c) => !c.ok).length;
  const shown: Record<string, number> = {
    findings: 0,
    checks: 0,
    patterns: patterns.length,
    known: 0,
    verdicts: 0,
    authors: 0,
    yield: yieldRows.filter((y) => y.source !== undefined).length,
  };
  for (const p of [
    "recalled",
    "uncalled",
    "toRead",
    "toExtract",
    "unclassed",
    "unfollowed",
    "people",
    "surveys",
    "children",
  ])
    shown[p] = top(p).length;
  return {
    ...small,
    ask: ask ? { ...ask, known: ask.known?.length ?? 0 } : null,
    rounds,
    findings: {
      kept: findings.kept.length,
      dropped: findings.dropped,
      thisRound: findings.kept.filter((f) => f.round === b.round).length,
    },
    checks: { ok: checks.length - failed, failed },
    patterns,
    hits: { read: hits.read, total: hits.total, uncalled: top("uncalled"), toRead: top("toRead") },
    documents: {
      total: documents.total,
      toExtract: top("toExtract"),
      unclassed: top("unclassed"),
    },
    people: top("people"),
    surveys: top("surveys", 3),
    children: top("children"),
    recalled: top("recalled", 5),
    unfollowed: top("unfollowed"),
    yield: yieldRows.filter((y) => y.source !== undefined),
    parts: PART_NAMES.map((p) => head(b, p, p === "surveys" ? top(p, 3).length : (shown[p] ?? 0))),
  };
}

export interface PartPage {
  part: string;
  about: string;
  /** The round read, or "all". */
  round?: number | "all";
  total: number;
  from: number;
  rows: unknown[];
  /** The command for the next page; null on the last. */
  next: string | null;
}

/** One part whole, a page at a time. A part by round takes the current round unless `round` says. */
export function briefPart(
  b: Brief,
  part: string,
  o: { round?: number | "all"; from?: number; n?: number } = {},
): PartPage {
  const p = PARTS[part];
  if (!p) throw new Error(`no part ${part}: one of ${PART_NAMES.join(", ")}`);
  const round = p.byRound ? (o.round ?? b.round) : undefined;
  const all = p.rows(b);
  const rows =
    round === undefined || round === "all" ? all : all.filter((r) => roundOf(r) === round);
  const from = Math.max(0, o.from ?? 0);
  const n = Math.max(1, o.n ?? PART_PAGE);
  const page = rows.slice(from, from + n);
  const more = from + n < rows.length;
  const flags = round !== undefined && o.round !== undefined ? ` --round ${round}` : "";
  return {
    part,
    about: p.about,
    ...(round !== undefined ? { round } : {}),
    total: rows.length,
    from,
    rows: page,
    next: more ? `birdwatch brief ${b.run} --part ${part}${flags} --from ${from + n}` : null,
  };
}
