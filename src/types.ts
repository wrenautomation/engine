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

export const Budget = z.object({
  /** Queries per round after the merge. Human queries never count against it. */
  queries: z.number().int().positive(),
  /** Documents to read per round. */
  reads: z.number().int().positive(),
  /** Rounds before `review` must stop. */
  rounds: z.number().int().positive(),
});
export type Budget = z.infer<typeof Budget>;

/**
 * The recipe for one ask kind: the prompts, the sources it may use, the budget. Versioned and
 * tuned like an SOP, stored beside the ledger. `{name}` marks in a prompt are filled from the
 * ask: `{ask}`, `{known}`, `{yield}`, `{n}`, `{year}`, `{site}`.
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
  why: z.string(),
  from: From,
  by: z.string(),
});
export type Triage = z.infer<typeof Triage>;

/** What one round came to, as counts and notes. The runner fills it; raven reads it. */
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
