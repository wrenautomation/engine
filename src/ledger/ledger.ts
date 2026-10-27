/**
 * The ledger contract: four calls every backend answers. `append` one record; `trace` one run's
 * records in time order; `scan` records across runs by a filter; `yield` what sources, proposers,
 * channels and ask kinds yielded, as raven's rows. The yield is a fold over records, shared here
 * so the files backend and a database compute the same rows (a database may do it in SQL).
 */
import type { YieldRow } from "@wrenautomation/raven";
import {
  byTime,
  type From,
  type LedgerRecord,
  type RecordOf,
  type RecordType,
  type Step,
} from "./records.js";

export interface Filter {
  run?: string;
  type?: RecordType | readonly RecordType[];
  from?: From;
  by?: string;
  step?: Step;
  round?: number;
  /** ISO time: records at or after it. */
  since?: string;
}

export interface YieldFilter {
  source?: string;
  by?: string;
  channel?: string;
  kind?: YieldRow["kind"];
}

export interface Ledger {
  append(record: LedgerRecord): Promise<void>;
  /** One run's records, by time then id. */
  trace(run: string): Promise<LedgerRecord[]>;
  /** Records across runs, by time then id. */
  scan(filter?: Filter): Promise<LedgerRecord[]>;
  yield(filter?: YieldFilter): Promise<YieldRow[]>;
}

export function matches(r: LedgerRecord, f: Filter): boolean {
  if (f.run !== undefined && r.run !== f.run) return false;
  if (f.type !== undefined && !(Array.isArray(f.type) ? f.type : [f.type]).includes(r.type))
    return false;
  if (f.from !== undefined && r.from !== f.from) return false;
  if (f.by !== undefined && r.by !== f.by) return false;
  if (f.step !== undefined && r.step !== f.step) return false;
  if (f.round !== undefined && r.round !== f.round) return false;
  if (f.since !== undefined && r.at < f.since) return false;
  return true;
}

export const ofType = <T extends RecordType>(records: readonly LedgerRecord[], type: T) =>
  records.filter((r): r is RecordOf<T> => r.type === type);

/** The latest call on each record: keep or drop. Records must be in time order. */
export function verdicts(records: readonly LedgerRecord[]): Map<string, "keep" | "drop"> {
  const out = new Map<string, "keep" | "drop">();
  for (const c of ofType(records, "call")) out.set(c.on, c.verdict);
  return out;
}

type Grain = "source" | "by" | "channel" | "kind";
interface Tally {
  grain: Grain;
  value: string;
  hits: Set<string>;
  reads: Set<string>;
  proposed: Set<string>;
  kept: Set<string>;
}

/**
 * Rows per source, per proposer (`by` of the queries), per channel and per ask kind: hits seen,
 * documents read, findings proposed, findings kept by the latest call. The chain is
 * query → hit → document → finding, so a finding counts for every source that returned its hit.
 * A finding is kept unless its latest call is a drop: the gate kept it; a review or a person drops.
 */
export function yieldRows(records: readonly LedgerRecord[], filter: YieldFilter = {}): YieldRow[] {
  const sorted = [...records].sort(byTime);
  const queries = new Map(ofType(sorted, "query").map((q) => [q.id, q]));
  const hits = new Map(ofType(sorted, "hit").map((h) => [h.id, h]));
  const documents = new Map(ofType(sorted, "document").map((d) => [d.id, d]));
  const kept = verdicts(sorted);
  const tallies = new Map<string, Tally>();
  const tally = (grain: Grain, value: string): Tally => {
    const k = `${grain}\u0000${value}`;
    let t = tallies.get(k);
    if (!t) {
      t = { grain, value, hits: new Set(), reads: new Set(), proposed: new Set(), kept: new Set() };
      tallies.set(k, t);
    }
    return t;
  };
  /** Every row a hit counts toward. */
  const grainsOf = (hit: RecordOf<"hit">): Tally[] => {
    const out: Tally[] = hit.sources.map((s) => tally("source", s));
    if (hit.channel) out.push(tally("channel", hit.channel));
    const bys = new Set<string>();
    const kinds = new Set<string>();
    for (const id of hit.queries) {
      const q = queries.get(id);
      if (!q) continue;
      bys.add(q.by);
      kinds.add(q.kind);
    }
    for (const b of bys) out.push(tally("by", b));
    for (const k of kinds) out.push(tally("kind", k));
    return out;
  };
  for (const h of hits.values()) for (const t of grainsOf(h)) t.hits.add(h.key);
  for (const d of documents.values()) {
    const h = hits.get(d.hit);
    if (h) for (const t of grainsOf(h)) t.reads.add(d.url);
  }
  for (const f of ofType(sorted, "finding")) {
    const d = documents.get(f.document);
    const h = d && hits.get(d.hit);
    if (!h) continue;
    for (const t of grainsOf(h)) {
      t.proposed.add(f.id);
      if (kept.get(f.id) !== "drop") t.kept.add(f.id);
    }
  }
  const want = (t: Tally): boolean => {
    const asked = (["source", "by", "channel", "kind"] as const).filter((g) => filter[g]);
    if (!asked.length) return true;
    return asked.some((g) => g === t.grain && filter[g] === t.value);
  };
  return [...tallies.values()].filter(want).map((t) => ({
    ...(t.grain === "kind"
      ? { kind: t.value as YieldRow["kind"] }
      : ({ [t.grain]: t.value } as Pick<YieldRow, "source" | "by" | "channel">)),
    hits: t.hits.size,
    reads: t.reads.size,
    proposed: t.proposed.size,
    kept: t.kept.size,
  }));
}
