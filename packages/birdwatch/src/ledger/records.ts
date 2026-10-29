/**
 * The records a ledger holds: one JSON object per line, append only. Every record has the same
 * envelope (`type`, `id`, `run`, `round`, `step`, `at`, `from`, `by`) and then its own fields;
 * the planner's (`./plan`) and the document's (`./document`) shapes are spread in with the envelope's fields taken out, so a record
 * has one `by`. A correction is a new record that points at the old one, never an edit.
 *
 * One rule for the lake: a top-level key keeps one JSON type across every record type, so
 * DuckDB's `read_json` unifies the files without a cast.
 */
import {
  Document as DocumentBase,
  Finding as FindingBase,
  Pattern as PatternBase,
  Verdict as VerdictBase,
} from "../document/index.js";
import {
  Ask,
  Budget,
  HitView,
  Edge as PlanEdge,
  Query as PlanQuery,
  Snapshot as PlanSnapshot,
  z,
} from "../plan/index.js";

/** Who wrote a record: a model, a person, or a tool (a source adapter, the runner). */
export const From = z.enum(["ai", "human", "tool"]);
export type From = z.infer<typeof From>;

/** The runner's steps, in order. The planner's `Edge.to` names one of the first five. */
export const Step = z.enum(["plan", "fetch", "triage", "read", "extract", "check", "review"]);
export type Step = z.infer<typeof Step>;
export const STEPS = Step.options;

export const RECORD_TYPES = [
  "query",
  "hit",
  "document",
  "finding",
  "verdict",
  "call",
  "spend",
  "snapshot",
  "edge",
  "done",
  "steer",
  "gap",
  "check",
  "pattern",
  "found",
  "draft",
  "class",
  "dead",
  "judge",
  "person",
] as const;
export const RecordType = z.enum(RECORD_TYPES);
export type RecordType = z.infer<typeof RecordType>;

/** What every record carries. `step` is absent on a record written outside a run's steps (a call by hand). */
export const Envelope = z.object({
  id: z.string().min(1),
  run: z.string().min(1),
  round: z.number().int().positive(),
  step: Step.optional(),
  /** ISO time from the writer's clock. */
  at: z.string().min(1),
  from: From,
  by: z.string().min(1),
});
export type Envelope = z.infer<typeof Envelope>;

/** What a follow lists from a page: its channel's or author's own posts, or pages like it. */
export const FOLLOW_AS = ["posts", "similar", "refs", "citers"] as const;
export const FollowAs = z.enum(FOLLOW_AS);
export type FollowAs = z.infer<typeof FollowAs>;

/** One thing to look for, as the plan step made it; or a follow: a page's own posts, or pages like it. */
export const QueryRecord = Envelope.extend({ type: z.literal("query") })
  .extend(PlanQuery.omit({ from: true, by: true }).shape)
  .extend({
    /** A follow's start: the URL, what to list, and the document that led there. */
    follow: z
      .object({ url: z.string().min(1), as: FollowAs, document: z.string().optional() })
      .optional(),
  });
export type QueryRecord = z.infer<typeof QueryRecord>;

/** What a source returned for a query, before any read. One per canonical URL per fetch step. */
export const HitRecord = Envelope.extend({ type: z.literal("hit") })
  .extend(HitView.shape)
  .extend({
    /** The canonical URL: what dedupe compares. */
    key: z.string().min(1),
    /** The query records it answered. */
    queries: z.array(z.string()),
  });
export type HitRecord = z.infer<typeof HitRecord>;

/** A hit read whole. */
export const DocumentRecord = Envelope.extend({ type: z.literal("document") })
  .extend(DocumentBase.shape)
  .extend({ hit: z.string().min(1) });
export type DocumentRecord = z.infer<typeof DocumentRecord>;

/** One fact drawn from a document, with its proof, and the document's date when it has one. */
export const FindingRecord = Envelope.extend({ type: z.literal("finding") })
  .extend(FindingBase.shape)
  .extend({
    document: z.string().min(1),
    date: z.string().optional(),
    /** The finding a failed check dropped, that this narrower sentence repairs. */
    fixes: z.string().optional(),
  });
export type FindingRecord = z.infer<typeof FindingRecord>;

/**
 * The extractor's word on a document once its findings are through the gate: how much of the
 * ask it held, and what the ask still lacks. One per document per extract; the extract step's
 * checkpoint, and the review's view of what the reads were worth.
 */
export const VerdictRecord = Envelope.extend({ type: z.literal("verdict") })
  .extend(VerdictBase.shape)
  .extend({ document: z.string().min(1) });
export type VerdictRecord = z.infer<typeof VerdictRecord>;

/**
 * The call: keep or drop, on a hit (read or skip) or a finding, with why. The latest call on a
 * record is its state. A person's call and a model's are the same row with a different `from`.
 */
export const CallRecord = Envelope.extend({
  type: z.literal("call"),
  on: z.string().min(1),
  verdict: z.enum(["keep", "drop"]),
  why: z.string(),
});
export type CallRecord = z.infer<typeof CallRecord>;

export const CostKind = z.enum(["free", "metered", "browser"]);
export type CostKind = z.infer<typeof CostKind>;

/** One use of a source or a model: what it was asked, whether it answered, what it cost. */
export const SpendRecord = Envelope.extend({
  type: z.literal("spend"),
  /** The source's name, or the model's id. */
  source: z.string().min(1),
  op: z.enum(["search", "open", "ask"]),
  /** The query's terms, the URL opened, or the prompt's first line. */
  about: z.string(),
  /** The record it was about: the query searched, the hit opened, the document extracted. */
  on: z.string().optional(),
  ok: z.boolean(),
  error: z.string().optional(),
  /** ISO time the source said to try again after, on a failure worth another try. */
  retryAfter: z.string().optional(),
  cost: CostKind,
  ms: z.number().nonnegative(),
  usd: z.number().nonnegative().optional(),
  tokens: z.object({ input: z.number().optional(), output: z.number().optional() }).optional(),
});
export type SpendRecord = z.infer<typeof SpendRecord>;

/** What the plan step was given for one round: the ask, the allow-list, the budget, the planner's snapshot. */
export const SnapshotRecord = Envelope.extend({ type: z.literal("snapshot") })
  .extend(PlanSnapshot.omit({ at: true }).shape)
  .extend({
    ask: Ask,
    sources: z.array(z.string()),
    /** Openers let in only to open or follow, never to search: a source in `sources` does all three. */
    opens: z.array(z.string()).default([]),
    budget: Budget,
    /** The run this one is a child of: its round when the child began, and why. Every round of the child carries it. */
    parent: z
      .object({
        run: z.string().min(1),
        round: z.number().int().positive(),
        why: z.string().min(1),
      })
      .optional(),
    /** On a root run: the pages the whole tree under it may read. Reads stop there. */
    treeReads: z.number().int().positive().optional(),
  });
export type SnapshotRecord = z.infer<typeof SnapshotRecord>;

/** The edge taken after a round. */
export const EdgeRecord = Envelope.extend({ type: z.literal("edge") }).extend(
  PlanEdge.omit({ from: true, by: true }).shape,
);
export type EdgeRecord = z.infer<typeof EdgeRecord>;

/** A step finished (`ok`) or gave up (`ok: false`, `note` says why). Resume reads these. */
export const DoneRecord = Envelope.extend({
  type: z.literal("done"),
  step: Step,
  ok: z.boolean(),
  note: z.string().optional(),
});
export type DoneRecord = z.infer<typeof DoneRecord>;

/**
 * What the person says to the run: free text, written between rounds (`birdwatch steer`), rendered
 * first in every prompt of the rounds after it. Always `from: human`; `step` absent.
 */
export const SteerRecord = Envelope.extend({ type: z.literal("steer"), text: z.string().min(1) });
export type SteerRecord = z.infer<typeof SteerRecord>;

/**
 * What a step or a person says the round lacks, in English: a query with no new hits, a hit no
 * source could open, a person's word. The round's review reads every gap, and the next round's
 * plan reads them as what was left open. `step` is the step that wrote it; a person's has none.
 */
export const GapRecord = Envelope.extend({
  type: z.literal("gap"),
  note: z.string().min(1),
  /** The record it is about: the query, the hit. */
  on: z.string().optional(),
});
export type GapRecord = z.infer<typeof GapRecord>;

/**
 * The sample check's word on one kept finding: does its quote back it? A finding that fails
 * also gets a drop call, so it leaves what the run has found; a person's keep puts it back.
 */
export const CheckRecord = Envelope.extend({
  type: z.literal("check"),
  on: z.string().min(1),
  ok: z.boolean(),
  why: z.string(),
});
export type CheckRecord = z.infer<typeof CheckRecord>;

/**
 * What several findings say together, by the agent (or the person): `./document`'s `Pattern`, its
 * source count computed by code when it is written. The report leads with patterns; a finding
 * no pattern rests on is a fact on its own. `step` absent: written between steps.
 */
export const PatternRecord = Envelope.extend({ type: z.literal("pattern") }).extend(
  PatternBase.shape,
);
export type PatternRecord = z.infer<typeof PatternRecord>;

/**
 * A hit the run already had came back for another query: the hit's record stays one, this says
 * which other query found it. The brief ranks a hit by how many facets found it.
 */
export const FoundRecord = Envelope.extend({
  type: z.literal("found"),
  hit: z.string().min(1),
  query: z.string().min(1),
});
export type FoundRecord = z.infer<typeof FoundRecord>;

/**
 * A rough synthesis over the run's kept findings and patterns: options, a pick, the gap that
 * would change it. Each item cites finding or pattern ids, and each number in it is in a cited
 * finding (the study's draft gate). A draft, never the final: a person or an agent polishes it
 * outside the ledger.
 */
export const DraftRecord = Envelope.extend({
  type: z.literal("draft"),
  /** What it is for: "a decision memo", "an SOP outline". */
  for: z.string().min(1),
  items: z
    .array(
      z.object({
        title: z.string(),
        body: z.string().min(1),
        cites: z.array(z.string().min(1)).min(1),
      }),
    )
    .min(1),
  /** Items the gate dropped, with why. */
  dropped: z.array(z.object({ title: z.string(), why: z.string() })).default([]),
});
export type DraftRecord = z.infer<typeof DraftRecord>;

/** What kind of source a page is. A closed set, so counts per class add up across agents. */
export const SOURCE_CLASSES = [
  "primary_data",
  "survey",
  "practitioner",
  "vendor",
  "forum",
  "news",
  "other",
] as const;
export const SourceClass = z.enum(SOURCE_CLASSES);
export type SourceClass = z.infer<typeof SourceClass>;

/**
 * The agent's word on what kind of source a document is, with why. Its findings take the class;
 * a class on a finding overrides it (a vendor page that quotes a survey). The latest per target
 * wins. The runner writes none.
 */
export const ClassRecord = Envelope.extend({
  type: z.literal("class"),
  on: z.string().min(1),
  class: SourceClass,
  why: z.string().min(1),
});
export type ClassRecord = z.infer<typeof ClassRecord>;

/**
 * A facet the agent gives up on, with why: thin after its tries. Later tiers and rounds of the
 * run skip it, and a parent's next plan reads it as a dead end.
 */
export const DeadRecord = Envelope.extend({
  type: z.literal("dead"),
  facet: z.string().min(1),
  why: z.string().min(1),
});
export type DeadRecord = z.infer<typeof DeadRecord>;

/**
 * A judge's answers on one hit, document or finding: each question's label probabilities (a
 * yes or no as `yes` and `no`). A hint and a router, never a call: the agent or a model decides.
 * `by` is the judge's model id; its spend carries the cost.
 */
export const JudgeRecord = Envelope.extend({
  type: z.literal("judge"),
  on: z.string().min(1),
  answers: z.record(z.string(), z.record(z.string(), z.number())),
});
export type JudgeRecord = z.infer<typeof JudgeRecord>;

/**
 * One person across platforms, by the agent, with why: the profile URLs (a channel, a Substack,
 * an X account, a blog) and the names they post under. Signals cluster in people: the brief
 * counts kept findings per person. The latest per name wins.
 */
export const PersonRecord = Envelope.extend({
  type: z.literal("person"),
  name: z.string().min(1),
  profiles: z.array(z.string().min(1)).default([]),
  aka: z.array(z.string().min(1)).default([]),
  why: z.string().min(1),
});
export type PersonRecord = z.infer<typeof PersonRecord>;

export const LedgerRecord = z.discriminatedUnion("type", [
  QueryRecord,
  HitRecord,
  DocumentRecord,
  FindingRecord,
  VerdictRecord,
  CallRecord,
  SpendRecord,
  SnapshotRecord,
  EdgeRecord,
  DoneRecord,
  SteerRecord,
  GapRecord,
  CheckRecord,
  PatternRecord,
  FoundRecord,
  DraftRecord,
  ClassRecord,
  DeadRecord,
  JudgeRecord,
  PersonRecord,
]);
export type LedgerRecord = z.infer<typeof LedgerRecord>;

/** A record of one type. */
export type RecordOf<T extends RecordType> = Extract<LedgerRecord, { type: T }>;

/** Time, then id: two writers' clocks can tie. */
export function byTime(a: Pick<Envelope, "at" | "id">, b: Pick<Envelope, "at" | "id">): number {
  return a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
