/**
 * A run's state is the fold of its records, never held between steps: every step reads the
 * trace again. The fold gives the ask, the round, the plan as raven made it, what each step
 * has handled, and the pointer: the next step to run, from the `done` and `edge` records.
 */
import { Plan } from "@wrenautomation/raven";
import { latestCalls, ofType } from "../ledger/ledger.js";
import {
  type CallRecord,
  type CheckRecord,
  type DocumentRecord,
  type DraftRecord,
  type EdgeRecord,
  type FindingRecord,
  type FoundRecord,
  type GapRecord,
  type HitRecord,
  type LedgerRecord,
  type PatternRecord,
  type QueryRecord,
  type SnapshotRecord,
  type SpendRecord,
  STEPS,
  type SteerRecord,
  type Step,
  type VerdictRecord,
} from "../ledger/records.js";

export interface Pointer {
  round: number;
  step: Step;
}

export interface RunState {
  run: string;
  records: LedgerRecord[];
  /** The latest snapshot: the ask and the allow-list. Absent before round 1's plan. */
  snapshot: SnapshotRecord | null;
  /** The round the pointer is in. */
  round: number;
  /** Where to go next; null when the run stopped. */
  next: Pointer | null;
  /** Why the run stopped or the last step gave up. */
  note: string | null;
  queries: QueryRecord[];
  hits: HitRecord[];
  documents: DocumentRecord[];
  findings: FindingRecord[];
  /** The extractor's word on each document it handled. */
  verdicts: VerdictRecord[];
  calls: CallRecord[];
  spends: SpendRecord[];
  edges: EdgeRecord[];
  /** What the person said along the way, oldest first. */
  steers: SteerRecord[];
  /** What a step or a person said a round lacks. */
  gaps: GapRecord[];
  /** The sample check's word on each finding it checked. */
  checks: CheckRecord[];
  /** What the agent says several findings say together. */
  patterns: PatternRecord[];
  drafts: DraftRecord[];
  /** A known hit found again by another query. */
  founds: FoundRecord[];
  /** The hit record for each canonical URL: a hit seen again, in any round, is a `found`, not a new record. */
  hitByKey: Map<string, string>;
  /** The latest call on each hit and finding. */
  called: Map<string, "keep" | "drop">;
}

const after = (step: Step): Step | null => STEPS[STEPS.indexOf(step) + 1] ?? null;

/** Records must be in time order. */
export function fold(run: string, records: readonly LedgerRecord[]): RunState {
  let next: Pointer | null = { round: 1, step: "plan" };
  let note: string | null = null;
  /** The round whose edge set the pointer: the review's own `done` then leaves it. */
  let edged = 0;
  for (const r of records) {
    if (r.type === "done") {
      if (!r.ok) {
        next = { round: r.round, step: r.step };
        note = r.note ?? null;
        continue;
      }
      if (r.step === "review" && edged === r.round) continue;
      const to = after(r.step);
      next = to ? { round: r.round, step: to } : null;
      note = null;
    } else if (r.type === "edge") {
      edged = r.round;
      if (r.next === "stop") next = null;
      else if (r.next === "again") next = { round: r.round + 1, step: "plan" };
      else if (r.to) next = { round: r.round, step: r.to };
      note = r.why;
    }
  }
  const snapshots = ofType(records, "snapshot");
  const hits = ofType(records, "hit");
  return {
    run,
    records: [...records],
    snapshot: snapshots.at(-1) ?? null,
    round: next?.round ?? snapshots.at(-1)?.round ?? 1,
    next,
    note,
    queries: ofType(records, "query"),
    hits,
    documents: ofType(records, "document"),
    findings: ofType(records, "finding"),
    verdicts: ofType(records, "verdict"),
    calls: ofType(records, "call"),
    spends: ofType(records, "spend"),
    edges: ofType(records, "edge"),
    steers: ofType(records, "steer"),
    gaps: ofType(records, "gap"),
    checks: ofType(records, "check"),
    patterns: ofType(records, "pattern"),
    drafts: ofType(records, "draft"),
    founds: ofType(records, "found"),
    hitByKey: new Map(hits.map((h) => [h.key, h.id])),
    called: latestCalls(records),
  };
}

const inRound =
  (round: number) =>
  <T extends { round: number }>(r: T) =>
    r.round === round;

/** The plan of a round as raven made it, rebuilt from its snapshot and queries. */
export function planOf(state: RunState, round: number): Plan {
  const s = ofType(state.records, "snapshot").filter(inRound(round)).at(-1);
  if (!s) throw new Error(`round ${round} has no snapshot`);
  const { ask, sources, budget, known, planFile, model, yieldRows, at } = s;
  return Plan.parse({
    ask,
    round,
    queries: state.queries.filter(inRound(round)).map((q) => ({
      kind: q.kind,
      terms: q.terms,
      ...(q.site ? { site: q.site } : {}),
      why: q.why,
      from: q.from === "tool" ? "ai" : q.from,
      by: q.by,
    })),
    sources,
    budget,
    snapshot: { at, known, planFile, model, yieldRows },
  });
}

/** A finding stays kept unless its latest call is a drop. */
export const kept = (state: RunState, f: FindingRecord): boolean =>
  state.called.get(f.id) !== "drop";

/** What the run has found so far: the kept findings' sentences with their URLs, oldest first. */
export const found = (state: RunState, round?: number): string[] =>
  state.findings
    .filter((f) => (round === undefined || f.round === round) && kept(state, f))
    .map((f) => `${f.text} (${f.proof.url})`);

/**
 * The round a person's gap or back edge is about. Between rounds (a pause, a stop) the pointer
 * is one ahead of the last review, so it is the round that review closed; mid-round, the current one.
 */
export const personRound = (state: RunState): number => {
  const last = state.edges.at(-1);
  return last && (!state.next || state.next.step === "plan") ? last.round : state.round;
};

/** The queries that found a hit: the one that wrote it, then every one it came back for. */
export const queriesOf = (state: RunState): Map<string, Set<string>> => {
  const out = new Map(state.hits.map((h) => [h.id, new Set(h.queries)]));
  for (const f of state.founds) out.get(f.hit)?.add(f.query);
  return out;
};

/** The hits of a round, the ones no call has named yet. */
export const uncalledHits = (state: RunState, round: number): HitRecord[] =>
  state.hits.filter((h) => h.round === round && !state.called.has(h.id));

/**
 * The hits to read: kept by triage in this round, no document yet. A failed open is tried again
 * on a rerun (`weaver back <run> read`).
 */
export const toRead = (state: RunState, round: number): HitRecord[] => {
  const read = new Set(state.documents.map((d) => d.hit));
  return state.hits.filter(
    (h) => h.round === round && state.called.get(h.id) === "keep" && !read.has(h.id),
  );
};

/**
 * The kept findings of a round to check, at most `n`, spread across documents: each document's
 * first unchecked finding, then each one's second, and so on. A finding with no quote, or one
 * checked already, is not in it. Findings come in record order, so the sample is the same on a rerun.
 */
export const toCheck = (state: RunState, round: number, n: number): FindingRecord[] => {
  const checked = new Set(state.checks.map((c) => c.on));
  const done = state.checks.filter((c) => c.round === round).length;
  const byDoc = new Map<string, FindingRecord[]>();
  for (const f of state.findings)
    if (f.round === round && f.proof.quote && !checked.has(f.id) && kept(state, f))
      byDoc.set(f.document, [...(byDoc.get(f.document) ?? []), f]);
  const out: FindingRecord[] = [];
  const lists = [...byDoc.values()];
  for (let i = 0; out.length < n - done && lists.some((l) => i < l.length); i++)
    for (const l of lists) {
      const f = l[i];
      if (f && out.length < n - done) out.push(f);
    }
  return out;
};

/** The documents of a round without a verdict: the extract step has not finished them. */
export const toExtract = (state: RunState, round: number): DocumentRecord[] => {
  const judged = new Set(state.verdicts.map((v) => v.document));
  return state.documents.filter((d) => d.round === round && !judged.has(d.id));
};
