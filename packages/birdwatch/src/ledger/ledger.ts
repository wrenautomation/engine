/**
 * The ledger contract: four calls every backend answers. `append` one record; `trace` one run's
 * records in time order; `scan` records across runs by a filter; `yield` what sources, proposers,
 * channels and ask kinds yielded, as the yield rows. The yield is a fold over records, shared here
 * so the files backend and a database compute the same rows (a database may do it in SQL).
 */
import type { AskKind, MetricKey, Metrics, PlanFile, YieldRow } from "../engine/types.js";
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
  /** The tuned plan file of a kind, when the ledger keeps plan files (the files backend does). */
  readPlan?(kind: AskKind): Promise<PlanFile | null>;
  writePlan?(planFile: PlanFile): Promise<string>;
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
export function latestCalls(records: readonly LedgerRecord[]): Map<string, "keep" | "drop"> {
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
  const kept = latestCalls(sorted);
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

/** One author's usual draw: per count, the median over their posts and the posts behind it. */
export type Baseline = Partial<Record<MetricKey, { median: number; n: number }>>;

/** Below it an author's median is noise: one post would be its own baseline. */
export const BASELINE_MIN_N = 5;

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
};

/**
 * Each author's (channel's) baseline over every run: per count, the median over the latest hit
 * record per URL that carries it, kept only from `minN` posts up. One author's own numbers, so
 * a big account and a small one compare by lift, not by size.
 */
export function baselines(
  records: readonly LedgerRecord[],
  minN = BASELINE_MIN_N,
): Map<string, Baseline> {
  const latest = new Map<string, RecordOf<"hit">>();
  for (const h of ofType([...records].sort(byTime), "hit"))
    if (h.channel && h.metrics) latest.set(h.key, h);
  const values = new Map<string, Partial<Record<MetricKey, number[]>>>();
  for (const h of latest.values()) {
    const channel = h.channel as string;
    const by = values.get(channel) ?? {};
    for (const [k, v] of Object.entries(h.metrics ?? {}) as [MetricKey, number][])
      (by[k] ??= []).push(v);
    values.set(channel, by);
  }
  const out = new Map<string, Baseline>();
  for (const [channel, by] of values) {
    const base: Baseline = {};
    for (const [k, xs] of Object.entries(by) as [MetricKey, number[]][])
      if (xs.length >= minN) base[k] = { median: median(xs), n: xs.length };
    if (Object.keys(base).length) out.set(channel, base);
  }
  return out;
}

/**
 * A hit's counts over its author's medians: 54.7 is 54.7 times what the author usually draws.
 * Only counts with a baseline; a zero median leaves the count out (a count over nothing), except
 * zero over zero, which is 1. Undefined when nothing compares.
 */
export function liftOf(
  hit: { channel?: string | undefined; metrics?: Metrics | undefined },
  base: ReadonlyMap<string, Baseline>,
): Partial<Record<MetricKey, number>> | undefined {
  const b = hit.channel ? base.get(hit.channel) : undefined;
  if (!b || !hit.metrics) return undefined;
  const out: Partial<Record<MetricKey, number>> = {};
  for (const [k, v] of Object.entries(hit.metrics) as [MetricKey, number][]) {
    const m = b[k];
    if (!m) continue;
    if (m.median > 0) out[k] = Math.round((v / m.median) * 100) / 100;
    else if (v === 0) out[k] = 1;
  }
  return Object.keys(out).length ? out : undefined;
}
