/**
 * The shapes raven owns. A query says what to look for and who asked for it; a plan is the
 * queries of one round plus the sources and budget it runs under; a plan file is the tuned
 * recipe per ask kind. Hits are weaver's; raven sees them through `HitView`, the fields a
 * source shows for free, because weaver depends on raven and not the reverse.
 */
import { z } from "zod";

export const AskKind = z.enum(["web", "video", "channel", "person", "site"]);
export type AskKind = z.infer<typeof AskKind>;

/** Who wrote a record: a model, a plan file or a person. */
export const From = z.enum(["ai", "human"]);
export type From = z.infer<typeof From>;

/** What someone wants to know, and what is known already. */
export const Ask = z.object({
  text: z.string().min(1),
  kind: AskKind,
  /** Facts already in hand, one line each: the planner looks past them. */
  known: z.array(z.string()).default([]),
  /** Lines taken as given with no source behind them: the plan tests each, never looks past it. */
  premises: z.array(z.string()).default([]),
  /** What the person said along the way, one line each: every prompt renders it first. */
  steer: z.array(z.string()).default([]),
  /** What the last round left open, one line each: its review's why, its gaps. The planner looks there first. */
  open: z.array(z.string()).default([]),
  /** Only for kind `site`, or when a query must stay on one host. */
  site: z.string().optional(),
});
export type Ask = z.infer<typeof Ask>;

/** One thing to look for. `terms` is what a person would type; a source adapter forms its own call from it. */
export const Query = z.object({
  kind: AskKind,
  terms: z.string().min(1),
  site: z.string().optional(),
  /** Why this query serves the ask: the line a reviewer reads first. */
  why: z.string(),
  /** The tree's facet it serves, and which try (1 = the first). Absent on a flat query. */
  facet: z.string().optional(),
  tier: z.number().int().positive().optional(),
  /** The source classes the facet needs (a spend claim: survey, primary_data); weaver checks the names. */
  needs: z.array(z.string().min(1)).optional(),
  from: From,
  /** Model id, plan file id or a person's name. */
  by: z.string(),
});
export type Query = z.infer<typeof Query>;

/** Queries from one proposer. The model is one; a plan file, a teammate or a second model are others. */
export const Proposal = z.object({
  from: From,
  by: z.string(),
  queries: z.array(Query.omit({ from: true, by: true })),
});
export type Proposal = z.infer<typeof Proposal>;

/** One query as a leaf of the tree: what a person would type, and why. */
export const Leaf = z.object({
  terms: z.string().min(1),
  why: z.string(),
  site: z.string().optional(),
});
export type Leaf = z.infer<typeof Leaf>;

/**
 * One side of the ask a researcher covers: a number, a how, a who, a counter-view, a primary
 * source. `tries` are its alternatives in order: the first runs; the next runs only when the
 * one before it yielded thin (fewer new hits than the guide's `thin`), or when the agent asks.
 */
export const Facet = z.object({
  name: z.string().min(1),
  /** What this facet would prove. */
  why: z.string(),
  /** The source classes that can prove it; a facet whose read pages have none of them is flagged. */
  needs: z.array(z.string().min(1)).optional(),
  tries: z.array(z.array(Leaf).min(1)).min(1),
});
export type Facet = z.infer<typeof Facet>;

/** The fan-out for one round: the facets, each with its tries. The agent writes it; weaver runs it. */
export const QueryTree = z.object({ facets: z.array(Facet).min(1) });
export type QueryTree = z.infer<typeof QueryTree>;

/** The plan file's guide for a tree: the facets a tree of this kind covers, and what thin means. A guide, not a cap: a tree may add facets; one it leaves out is a warning. */
export const TreeGuide = z.object({
  facets: z.array(z.object({ name: z.string().min(1), why: z.string() })),
  /** New hits under which a try counts as thin, so the next try runs. */
  thin: z.number().int().nonnegative(),
});
export type TreeGuide = z.infer<typeof TreeGuide>;

export const Budget = z.object({
  /** Queries per round after the merge. Human queries never count against it. */
  queries: z.number().int().positive(),
  /** Documents to read per round. */
  reads: z.number().int().positive(),
  /** Rounds before `review` must stop. */
  rounds: z.number().int().positive(),
  /** Kept findings per round that a model checks against their document: a sample spread across the documents. 0: none. */
  checks: z.number().int().nonnegative().default(3),
});
export type Budget = z.infer<typeof Budget>;

/**
 * The recipe for one ask kind: the prompts, the sources it may use, the budget. Versioned and
 * tuned like an SOP, stored beside the ledger. `{name}` marks in a prompt are filled from the
 * ask: `{ask}`, `{known}`, `{yield}`, `{n}`, `{year}`, `{site}`, `{open}`, `{age}`; the review's
 * also `{gaps}` and `{checks}`.
 */
export const PlanFile = z.object({
  id: z.string().min(1),
  kind: AskKind,
  version: z.number().int().positive(),
  /** Asks the model for queries. Must say to answer with `{"queries":[{"terms","why","site?"}]}`. */
  propose: z.string().min(1),
  /** Asks the model to read or skip each hit. Must say to answer with `{"hits":[{"url","read","why"}]}`. */
  triage: z.string().min(1),
  /** Asks the model which edge to take after a round. Must say to answer with `{"next","to?","why"}`. */
  review: z.string().min(1),
  /** Source names a run may use, in order of preference. A run can narrow the list, never widen it. */
  sources: z.array(z.string()),
  budget: Budget,
  /** How much a source's age counts for this kind, one sentence: filled as `{age}`. Never a cutoff. */
  age: z.string().optional(),
  /** The facets a query tree of this kind covers. Absent on a file from before version 6: the kind's default. */
  tree: TreeGuide.optional(),
  /**
   * The run tree's caps. `depth`: levels from the root (2: the root and its children); past it a
   * warning, not a stop. `children`: per parent round. `reads`: pages the whole tree may read, the
   * one hard stop; absent, the root's reads times rounds times (children + 1). Absent: 2 and 6.
   */
  runs: z
    .object({
      depth: z.number().int().positive(),
      children: z.number().int().positive(),
      reads: z.number().int().positive().optional(),
    })
    .optional(),
});
export type PlanFile = z.infer<typeof PlanFile>;

/** What a source, channel or proposer yielded before. Raven reads it; wren or the files ledger writes it. */
export const YieldRow = z.object({
  by: z.string().optional(),
  source: z.string().optional(),
  channel: z.string().optional(),
  kind: AskKind.optional(),
  hits: z.number().int().nonnegative(),
  reads: z.number().int().nonnegative(),
  proposed: z.number().int().nonnegative(),
  kept: z.number().int().nonnegative(),
});
export type YieldRow = z.infer<typeof YieldRow>;

/** What raven was given for one round: the RL state, kept with the plan. */
export const Snapshot = z.object({
  at: z.string(),
  known: z.array(z.string()),
  planFile: z.object({ id: z.string(), version: z.number().int() }),
  model: z.string().nullable(),
  yieldRows: z.number().int().nonnegative(),
});
export type Snapshot = z.infer<typeof Snapshot>;

export const Plan = z.object({
  ask: Ask,
  round: z.number().int().positive(),
  queries: z.array(Query),
  sources: z.array(z.string()),
  budget: Budget,
  snapshot: Snapshot,
});
export type Plan = z.infer<typeof Plan>;

/** A hit as a source shows it for free: no read has happened. `sources` is every source that returned it. */
export const HitView = z.object({
  url: z.string().min(1),
  title: z.string().optional(),
  channel: z.string().optional(),
  /** Seconds, for video and audio. */
  length: z.number().nonnegative().optional(),
  /** ISO date, when the source gives one. */
  date: z.string().optional(),
  snippet: z.string().optional(),
  sources: z.array(z.string()).default([]),
});
export type HitView = z.infer<typeof HitView>;
/** A hit as a caller may pass it: `sources` optional. */
export type HitViewIn = z.input<typeof HitView>;

export const Triage = z.object({
  url: z.string(),
  read: z.boolean(),
  /** The model's line on a read; a skip's is fixed text, so the model writes none. */
  why: z.string(),
  from: From,
  by: z.string(),
});
export type Triage = z.infer<typeof Triage>;

/** The extractor's word on one read document: how much of the ask it served, what is still missing. */
export const Verdict = z.object({
  url: z.string(),
  quality: z.enum(["rich", "thin", "off", "empty"]),
  gap: z.string().optional(),
});
export type Verdict = z.infer<typeof Verdict>;

/** What one round came to, as counts, verdicts and notes. The runner fills it; raven reads it. */
export const Round = z.object({
  ask: Ask,
  round: z.number().int().positive(),
  budget: Budget,
  hits: z.number().int().nonnegative(),
  reads: z.number().int().nonnegative(),
  proposed: z.number().int().nonnegative(),
  kept: z.number().int().nonnegative(),
  /** What the kept findings say, one line each: the planner sees what is answered. */
  found: z.array(z.string()).default([]),
  /** What went wrong or ran out, one line each. */
  notes: z.array(z.string()).default([]),
  /** The extractor's verdict on each document read this round: the planner sees what the reads were worth. */
  verdicts: z.array(Verdict).default([]),
  /** What a step or a person said the round lacks, one line each, the step or the person first. */
  gaps: z.array(z.string()).default([]),
  /** The sample check: whether each checked finding's quote backs it, one line each. */
  checks: z.array(z.string()).default([]),
});
export type Round = z.infer<typeof Round>;

export const Step = z.enum(["plan", "fetch", "triage", "read", "extract"]);
export type Step = z.infer<typeof Step>;

/** The edge out of a round. `again` is a new round from `plan`; `back` reruns one step of this round. */
export const Edge = z.object({
  next: z.enum(["stop", "again", "back"]),
  to: Step.optional(),
  why: z.string(),
  from: From,
  by: z.string(),
});
export type Edge = z.infer<typeof Edge>;

export { z };
