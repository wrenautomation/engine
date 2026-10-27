/**
 * A run's state is the fold of its records, never held between steps: every step reads the
 * trace again. The fold gives the ask, the round, the plan as raven made it, what each step
 * has handled, and the pointer: the next step to run, from the `done` and `edge` records.
 */
import { Plan } from "@wrenautomation/raven";
import { latestCalls, ofType } from "../ledger/ledger.js";
import {
  type CallRecord,
  type DocumentRecord,
  type EdgeRecord,
  type FindingRecord,
  type HitRecord,
  type LedgerRecord,
  type QueryRecord,
  type SnapshotRecord,
  type SpendRecord,
  STEPS,
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
  /** Keys of every hit in the run: a hit seen again in a later round is not a new record. */
  seen: Set<string>;
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
    seen: new Set(hits.map((h) => h.key)),
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

/** What the run has found so far: the kept findings' sentences, oldest first. */
export const found = (state: RunState, round?: number): string[] =>
  state.findings
    .filter((f) => (round === undefined || f.round === round) && kept(state, f))
    .map((f) => f.text);

/** The hits of a round, the ones no call has named yet. */
export const uncalledHits = (state: RunState, round: number): HitRecord[] =>
  state.hits.filter((h) => h.round === round && !state.called.has(h.id));

/** The hits to read: kept by triage in this round, no document yet, no failed open on record. */
export const toRead = (state: RunState, round: number): HitRecord[] => {
  const read = new Set(state.documents.map((d) => d.hit));
  return state.hits.filter(
    (h) => h.round === round && state.called.get(h.id) === "keep" && !read.has(h.id),
  );
};

/** The documents of a round without a verdict: the extract step has not finished them. */
export const toExtract = (state: RunState, round: number): DocumentRecord[] => {
  const judged = new Set(state.verdicts.map((v) => v.document));
  return state.documents.filter((d) => d.round === round && !judged.has(d.id));
};
