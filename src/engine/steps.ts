/**
 * The step table: one typed call per step, records in, records out. The runner interprets it in
 * order; wren's executor mounts the same table as stations. A step reads the fold, calls ports,
 * and appends records; it holds nothing between calls.
 */
import type { Model } from "@wrenautomation/raven";
import { dedupeHits, defaultPlanFile, plan, review, triage } from "@wrenautomation/raven";
import type { Envelope, From, LedgerRecord, Step } from "../ledger/records.js";
import { canonical } from "./canonical.js";
import { type Deps, pick, type RunOptions, type Source } from "./ports.js";
import { found, planOf, type RunState, toExtract, toRead, uncalledHits } from "./state.js";

export interface StepContext {
  deps: Deps;
  options: RunOptions;
  /** The run's model, wrapped so every ask writes a spend. */
  model: Model | null;
  /** The same model, its spends marked with the record they are about. */
  modelOn(on: string): Model | null;
  run: string;
  round: number;
  step: Step;
  /** Appends one record with the envelope filled in. */
  write<T extends Omit<LedgerRecord, keyof Envelope>>(
    record: T,
    who: { from: From; by: string },
  ): Promise<string>;
  /** Times a source call and writes its spend; a throw becomes `ok: false` and null. */
  invoke<T>(
    source: Source,
    op: "search" | "open",
    about: string,
    on: string,
    call: () => Promise<T>,
  ): Promise<T | null>;
}

export type StepResult = { ok: true; note?: string } | { ok: false; note: string };
export type StepFn = (ctx: StepContext, state: RunState) => Promise<StepResult>;

const tool = (by: string) => ({ from: "tool" as const, by });

const sourcesOf = (ctx: StepContext, state: RunState): Source[] =>
  pick(ctx.deps.sources, state.snapshot?.sources ?? []);

export const planStep: StepFn = async (ctx, state) => {
  const ask = state.snapshot?.ask ?? ctx.options.ask;
  if (!ask) return { ok: false, note: "no ask: a new run needs one" };
  const planFile = ctx.options.planFile ?? defaultPlanFile(ask.kind);
  const yieldRows = await ctx.deps.ledger.yield();
  const known = [...new Set([...(ask.known ?? []), ...found(state)])];
  const p = await plan({
    ask: { ...ask, known },
    planFile,
    model: ctx.model,
    proposals: ctx.round === 1 ? (ctx.options.proposals ?? []) : [],
    yieldRows,
    ...(ctx.options.sources ? { sources: ctx.options.sources } : {}),
    round: ctx.round,
    now: ctx.deps.clock,
  });
  pick(ctx.deps.sources, p.sources);
  const { at: _at, ...snapshot } = p.snapshot;
  await ctx.write(
    { type: "snapshot", ask: p.ask, sources: p.sources, budget: p.budget, ...snapshot },
    tool(ctx.deps.runner),
  );
  for (const { from, by, ...q } of p.queries)
    await ctx.write({ type: "query", ...q }, { from, by });
  return p.queries.length
    ? { ok: true, note: `${p.queries.length} queries over ${p.sources.join(", ")}` }
    : { ok: false, note: "no queries: nothing proposed" };
};

export const fetchStep: StepFn = async (ctx, state) => {
  const queries = state.queries.filter((q) => q.round === ctx.round);
  const searchers = sourcesOf(ctx, state).filter((s) => s.search);
  if (!searchers.length) return { ok: false, note: "no search source in the allow-list" };
  const seen = new Set(state.seen);
  let written = 0;
  let calls = 0;
  for (const q of queries) {
    const byKey = new Map<
      string,
      { hit: Parameters<typeof dedupeHits>[0][number]; by: string; from: From }
    >();
    for (const s of searchers) {
      calls++;
      const hits = await ctx.invoke(s, "search", q.terms, q.id, () =>
        (s.search as NonNullable<Source["search"]>)(q),
      );
      for (const h of hits ?? []) {
        const key = canonical(h.url);
        const got = byKey.get(key);
        if (got) got.hit.sources = [...new Set([...(got.hit.sources ?? []), s.name])];
        else
          byKey.set(key, {
            hit: { ...h, sources: [s.name] },
            by: s.by ?? s.name,
            from: s.from ?? "tool",
          });
      }
    }
    for (const [key, { hit, by, from }] of byKey) {
      if (seen.has(key)) continue;
      seen.add(key);
      const [view] = dedupeHits([hit]);
      if (!view) continue;
      await ctx.write({ type: "hit", ...view, key, queries: [q.id] }, { from, by });
      written++;
    }
  }
  return { ok: true, note: `${written} new hits from ${calls} searches` };
};

export const triageStep: StepFn = async (ctx, state) => {
  const hits = uncalledHits(state, ctx.round);
  if (!hits.length) return { ok: true, note: "no hits to triage" };
  const p = planOf(state, ctx.round);
  const byUrl = new Map(hits.map((h) => [h.url, h]));
  if (!ctx.model) {
    const budget = Math.max(0, p.budget.reads - toRead(state, ctx.round).length);
    for (const [i, h] of hits.entries())
      await ctx.write(
        {
          type: "call",
          on: h.id,
          verdict: i < budget ? "keep" : "drop",
          why: i < budget ? "no model: read in order" : "no model: over the read budget",
        },
        tool(ctx.deps.runner),
      );
    return { ok: true, note: `no model: ${Math.min(budget, hits.length)} reads` };
  }
  const planFile = ctx.options.planFile ?? defaultPlanFile(p.ask.kind);
  const views = hits.map(
    ({
      type: _t,
      id: _i,
      run: _r,
      round: _ro,
      step: _s,
      at: _a,
      from: _f,
      by: _b,
      key: _k,
      queries: _q,
      ...view
    }) => view,
  );
  const calls = await triage(views, p, ctx.model, {
    planFile,
    yieldRows: await ctx.deps.ledger.yield(),
  });
  let reads = 0;
  for (const c of calls) {
    const h = byUrl.get(c.url);
    if (!h) continue;
    if (c.read) reads++;
    await ctx.write(
      { type: "call", on: h.id, verdict: c.read ? "keep" : "drop", why: c.why },
      { from: c.from, by: c.by },
    );
  }
  return { ok: true, note: `${reads} of ${hits.length} hits to read` };
};

export const readStep: StepFn = async (ctx, state) => {
  const hits = toRead(state, ctx.round);
  const openers = sourcesOf(ctx, state).filter((s) => s.open);
  if (hits.length && !openers.length)
    return { ok: false, note: "no open source in the allow-list" };
  let read = 0;
  for (const h of hits) {
    for (const s of openers) {
      const doc = await ctx.invoke(s, "open", h.url, h.id, () =>
        (s.open as NonNullable<Source["open"]>)(h),
      );
      if (!doc) continue;
      await ctx.write(
        { type: "document", ...doc, hit: h.id },
        { from: s.from ?? "tool", by: s.by ?? s.name },
      );
      read++;
      break;
    }
  }
  return { ok: true, note: `${read} of ${hits.length} hits read` };
};

export const extractStep: StepFn = async (ctx, state) => {
  const docs = toExtract(state, ctx.round);
  if (!docs.length) return { ok: true, note: "nothing to extract" };
  if (!ctx.model) return { ok: false, note: "no model: nothing extracted" };
  const ask = state.snapshot?.ask;
  if (!ask) return { ok: false, note: "no snapshot" };
  const known = [...new Set([...ask.known, ...found(state)])];
  let proposed = 0;
  let dropped = 0;
  for (const d of docs) {
    const {
      type: _t,
      id,
      run: _r,
      round: _ro,
      step: _s,
      at: _a,
      from: _f,
      by: _b,
      hit: _h,
      ...doc
    } = d;
    const model = ctx.modelOn(id);
    if (!model) break;
    const out = await ctx.deps.extractor.extract(doc, { text: ask.text, known }, model);
    for (const f of out.findings)
      await ctx.write({ type: "finding", ...f, document: id }, { from: "ai", by: model.id });
    proposed += out.findings.length;
    dropped += out.dropped.length;
  }
  return {
    ok: true,
    note: `${proposed} findings from ${docs.length} documents, ${dropped} dropped at the gate`,
  };
};

export const reviewStep: StepFn = async (ctx, state) => {
  const p = planOf(state, ctx.round);
  const inRound = <T extends { round: number }>(r: T) => r.round === ctx.round;
  const hits = state.hits.filter(inRound).length;
  const reads = state.documents.filter(inRound).length;
  const proposed = state.findings.filter(inRound).length;
  const foundNow = found(state, ctx.round);
  const round = {
    ask: p.ask,
    round: ctx.round,
    budget: p.budget,
    hits,
    reads,
    proposed,
    kept: foundNow.length,
    found: foundNow,
    notes: state.spends
      .filter((s) => inRound(s) && !s.ok)
      .map((s) => `${s.source} ${s.op} failed: ${s.error ?? "?"}`),
  };
  const edge = ctx.model
    ? await review(round, ctx.model, {
        planFile: ctx.options.planFile ?? defaultPlanFile(p.ask.kind),
      })
    : {
        next: "stop" as const,
        why: "no model: one round",
        from: "human" as const,
        by: ctx.deps.runner,
      };
  if (edge.next === "back" && !edge.to)
    return { ok: false, note: "the edge says back but names no step" };
  const { from, by, ...rest } = edge;
  await ctx.write({ type: "edge", ...rest }, { from, by });
  return { ok: true, note: `${edge.next}${edge.to ? ` to ${edge.to}` : ""}: ${edge.why}` };
};

export const STEP_TABLE: Record<Step, StepFn> = {
  plan: planStep,
  fetch: fetchStep,
  triage: triageStep,
  read: readStep,
  extract: extractStep,
  review: reviewStep,
};
