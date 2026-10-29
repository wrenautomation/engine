/**
 * A run as a viewer draws it: the agent's brief plus every query, hit, page and finding with
 * its links, and the back and forth in time order. Read only; `birdwatch serve` sends it as JSON.
 * A host copies these types (`v` says which shape), never imports them: the seam is the JSON.
 */
import type { LedgerRecord } from "../ledger/records.js";
import { type Brief, brief } from "./agent.js";
import { ownersOf } from "./people.js";
import type { Deps } from "./ports.js";
import { fold, kept, type RunState } from "./state.js";

type Who = { from: string; by: string };
type Answers = Record<string, Record<string, number>>;

export interface RunQuery extends Who {
  id: string;
  round: number;
  at: string;
  terms: string;
  why: string;
  site?: string;
  facet?: string;
  tier?: number;
  follow?: { url: string; as: string; document?: string };
  /** Hits it wrote, then known hits it found again. */
  hits: string[];
  again: string[];
}

export interface RunHit extends Who {
  id: string;
  round: number;
  url: string;
  title?: string;
  channel?: string;
  snippet?: string;
  date?: string;
  length?: number;
  /** The sources that returned it. */
  sources: string[];
  /** Every query that returned it, the first one first. */
  queries: string[];
  call?: { verdict: "keep" | "drop"; why?: string } & Who;
  judge?: Answers;
  document?: string;
}

export interface RunDocument extends Who {
  id: string;
  hit: string;
  url: string;
  title?: string;
  channel?: string;
  media: string;
  date?: string;
  length?: number;
  chars: number;
  class?: string;
  judge?: Answers;
  verdict?: { quality: string; gap?: string };
  /** The person record that owns it. */
  person?: string;
}

export interface RunFinding extends Who {
  id: string;
  round: number;
  document: string;
  text: string;
  quote?: string;
  date?: string;
  kept: boolean;
  fixes?: string;
  class?: string;
  judge?: Answers;
  checks: ({ ok: boolean; why: string; at: string } & Who)[];
}

/** One step of the back and forth: a decision with its why, or a step's end with its note. */
export interface Moment extends Who {
  id: string;
  at: string;
  round: number;
  step?: string;
  type: string;
  text: string;
  why?: string;
  /** The record it is about. */
  on?: string;
  ok?: boolean;
}

export interface RunView {
  v: 1;
  run: string;
  brief: Brief;
  queries: RunQuery[];
  hits: RunHit[];
  documents: RunDocument[];
  findings: RunFinding[];
  timeline: Moment[];
  /** Spend per source and op. */
  spend: { source: string; op: string; calls: number; failed: number; usd: number }[];
}

/** One line per run for a list. */
export interface RunRow {
  run: string;
  ask: string;
  kind: string;
  parent: string | null;
  round: number;
  /** Null once an edge said stop. */
  next: { round: number; step: string } | null;
  note: string | null;
  started: string;
  updated: string;
  hits: number;
  documents: number;
  kept: number;
  usd: number;
}

const who = (r: LedgerRecord): Who => ({ from: r.from, by: r.by });
const some = <T>(v: T | undefined, k: string) => (v === undefined ? {} : { [k]: v });

export function rowOf(state: RunState): RunRow {
  const s = state.snapshot;
  return {
    run: state.run,
    ask: s?.ask.text ?? "",
    kind: s?.ask.kind ?? "",
    parent: s?.parent?.run ?? null,
    round: state.round,
    next: state.next,
    note: state.note,
    started: state.records[0]?.at ?? "",
    updated: state.records.at(-1)?.at ?? "",
    hits: state.hits.length,
    documents: state.documents.length,
    kept: state.findings.filter((f) => kept(state, f)).length,
    usd: state.spends.reduce((a, x) => a + (x.usd ?? 0), 0),
  };
}

/** The record a moment shows, or null for bulk records (hits, pages, the judge, spends). */
function momentOf(r: LedgerRecord): Moment | null {
  const base = { id: r.id, at: r.at, round: r.round, ...some(r.step, "step"), ...who(r) };
  switch (r.type) {
    case "snapshot":
      return { ...base, type: r.type, text: `plan: ${r.ask.text}`, why: r.sources.join(", ") };
    case "query":
      return {
        ...base,
        type: r.type,
        text: r.follow ? `follow ${r.follow.as} of ${r.follow.url}` : r.terms,
        why: r.why,
        ...some(r.facet, "on"),
      };
    case "call":
      return { ...base, type: r.type, text: r.verdict, on: r.on, ...some(r.why, "why") };
    case "check":
      return {
        ...base,
        type: r.type,
        text: r.ok ? "backed" : "failed",
        on: r.on,
        why: r.why,
        ok: r.ok,
      };
    case "edge":
      return { ...base, type: r.type, text: r.next, why: r.why };
    case "done":
      return { ...base, type: r.type, text: r.step, ok: r.ok, ...some(r.note, "why") };
    case "gap":
      return { ...base, type: r.type, text: r.note, ...some(r.on, "on") };
    case "steer":
      return { ...base, type: r.type, text: r.text };
    case "class":
      return { ...base, type: r.type, text: r.class, on: r.on, why: r.why };
    case "pattern":
      return { ...base, type: r.type, text: r.text };
    case "person":
      return { ...base, type: r.type, text: r.name, why: r.why };
    case "dead":
      return { ...base, type: r.type, text: r.facet, why: r.why };
    case "draft":
      return { ...base, type: r.type, text: r.for };
    // A finding written by hand; the extract's bulk ones show in its step's end.
    case "finding":
      return r.step ? null : { ...base, type: r.type, text: r.text, on: r.document };
    default:
      return null;
  }
}

export function viewOf(state: RunState, b: Brief): RunView {
  const calls = new Map<string, LedgerRecord & { type: "call" }>();
  for (const c of state.calls) calls.set(c.on, c);
  const docOfHit = new Map(state.documents.map((d) => [d.hit, d.id]));
  const owners = ownersOf(state);
  const verdicts = new Map(state.verdicts.map((v) => [v.document, v]));
  const hitQueries = new Map(state.hits.map((h) => [h.id, [...h.queries]]));
  const again = new Map<string, string[]>();
  for (const f of state.founds) {
    hitQueries.get(f.hit)?.push(f.query);
    again.set(f.query, [...(again.get(f.query) ?? []), f.hit]);
  }
  const wrote = new Map<string, string[]>();
  for (const h of state.hits) {
    const q = h.queries[0];
    if (q) wrote.set(q, [...(wrote.get(q) ?? []), h.id]);
  }
  const checks = new Map<string, RunFinding["checks"]>();
  for (const c of state.checks)
    checks.set(c.on, [...(checks.get(c.on) ?? []), { ok: c.ok, why: c.why, at: c.at, ...who(c) }]);
  const callOf = (id: string) => {
    const c = calls.get(id);
    return c ? { call: { verdict: c.verdict, ...some(c.why, "why"), ...who(c) } } : {};
  };
  const spend = new Map<string, RunView["spend"][number]>();
  for (const s of state.spends) {
    const k = `${s.source}\u0000${s.op}`;
    const row = spend.get(k) ?? { source: s.source, op: s.op, calls: 0, failed: 0, usd: 0 };
    row.calls++;
    if (!s.ok) row.failed++;
    row.usd += s.usd ?? 0;
    spend.set(k, row);
  }
  return {
    v: 1,
    run: state.run,
    brief: b,
    queries: state.queries.map((q) => ({
      id: q.id,
      round: q.round,
      at: q.at,
      terms: q.terms,
      why: q.why,
      ...some(q.site, "site"),
      ...some(q.facet, "facet"),
      ...some(q.tier, "tier"),
      ...some(q.follow, "follow"),
      hits: wrote.get(q.id) ?? [],
      again: again.get(q.id) ?? [],
      ...who(q),
    })),
    hits: state.hits.map((h) => ({
      id: h.id,
      round: h.round,
      url: h.url,
      ...some(h.title, "title"),
      ...some(h.channel, "channel"),
      ...some(h.snippet, "snippet"),
      ...some(h.date, "date"),
      ...some(h.length, "length"),
      sources: h.sources,
      queries: hitQueries.get(h.id) ?? h.queries,
      ...callOf(h.id),
      ...some(state.judged.get(h.id), "judge"),
      ...some(docOfHit.get(h.id), "document"),
      ...who(h),
    })),
    documents: state.documents.map((d) => {
      const v = verdicts.get(d.id);
      return {
        id: d.id,
        hit: d.hit,
        url: d.url,
        ...some(d.title, "title"),
        ...some(d.channel ?? state.hits.find((h) => h.id === d.hit)?.channel, "channel"),
        media: d.media,
        ...some(d.date, "date"),
        ...some(d.length, "length"),
        chars: d.text.length,
        ...some(state.classOf.get(d.id), "class"),
        ...some(state.judged.get(d.id), "judge"),
        ...(v ? { verdict: { quality: v.quality, ...some(v.gap, "gap") } } : {}),
        ...some(owners.get(d.id)?.id, "person"),
        ...who(d),
      };
    }),
    findings: state.findings.map((f) => ({
      id: f.id,
      round: f.round,
      document: f.document,
      text: f.text,
      ...some(f.proof.quote ?? undefined, "quote"),
      ...some(f.date, "date"),
      kept: kept(state, f),
      ...some(f.fixes, "fixes"),
      ...some(state.classOf.get(f.id), "class"),
      ...some(state.judged.get(f.id), "judge"),
      checks: checks.get(f.id) ?? [],
      ...who(f),
    })),
    timeline: state.records.flatMap((r) => momentOf(r) ?? []),
    spend: [...spend.values()].sort((a, b) => b.usd - a.usd || b.calls - a.calls),
  };
}

/** A run's view from its ledger. */
export async function runView(deps: Deps, run: string): Promise<RunView> {
  const records = await deps.ledger.trace(run);
  if (!records.length) throw new Error(`run ${run}: no records`);
  return viewOf(fold(run, records), await brief(deps, run));
}
