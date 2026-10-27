/**
 * The step table: one typed call per step, records in, records out. The runner interprets it in
 * order; wren's executor mounts the same table as stations. A step reads the fold, calls ports,
 * and appends records; it holds nothing between calls. Source calls fan out (per query across
 * the searchers; reads and extracts a few at a time) and their records land in order, so a
 * trace reads the same whatever answered first. A step runs again after a transient failure
 * from where its records say it got to: a search with an ok spend, a hit with a document, a
 * document with a verdict, are not done twice.
 */
import type { Model } from "@wrenautomation/raven";
import { dedupeHits, defaultPlanFile, plan, review, triage } from "@wrenautomation/raven";
import type {
  DocumentRecord,
  Envelope,
  From,
  HitRecord,
  LedgerRecord,
  Step,
} from "../ledger/records.js";
import { canonical } from "./canonical.js";
import { type Deps, pick, type RunOptions, type Source } from "./ports.js";
import { found, planOf, type RunState, toExtract, toRead, uncalledHits } from "./state.js";
import { Transient } from "./transient.js";

export interface StepContext {
  deps: Deps;
  options: RunOptions;
  /** The run's model, wrapped so every ask writes a spend; a Transient after the tries run out. */
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
  /**
   * Times a source call and writes its spend. A throw becomes `ok: false` and null; a
   * Transient is tried again, and thrown when the tries run out.
   */
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

/** Reads and extracts in flight at once. */
export const PARALLEL = 4;

const tool = (by: string) => ({ from: "tool" as const, by });

const sourcesOf = (ctx: StepContext, state: RunState): Source[] =>
  pick(ctx.deps.sources, state.snapshot?.sources ?? []);

/** Settled calls in order: the values, the first Transient, and any other error thrown on. */
function gather<T>(settled: PromiseSettledResult<T>[]): {
  values: (T | null)[];
  transient: Transient | null;
} {
  let transient: Transient | null = null;
  const values = settled.map((r) => {
    if (r.status === "fulfilled") return r.value;
    if (r.reason instanceof Transient) {
      transient ??= r.reason;
      return null;
    }
    throw r.reason;
  });
  return { values, transient };
}

/**
 * `call` a few at a time, in order; `keep` gets each batch's answers (null where the call
 * failed) before the next batch starts, so what one item wrote is on record whatever the next
 * does. The first Transient comes back; the first other error is thrown once its batch is kept.
 */
async function batched<I, O>(
  items: I[],
  call: (item: I) => Promise<O>,
  keep: (item: I, out: O) => Promise<void>,
): Promise<{ transient: Transient | null }> {
  let transient: Transient | null = null;
  for (let i = 0; i < items.length; i += PARALLEL) {
    const batch = items.slice(i, i + PARALLEL);
    const settled = await Promise.allSettled(batch.map(call));
    let failed: unknown;
    let anyFailed = false;
    for (const [j, r] of settled.entries()) {
      if (r.status === "fulfilled") await keep(batch[j] as I, r.value);
      else if (r.reason instanceof Transient) transient ??= r.reason;
      else if (!anyFailed) {
        anyFailed = true;
        failed = r.reason;
      }
    }
    if (anyFailed) throw failed;
  }
  return { transient };
}

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
  const searched = new Set(
    state.spends
      .filter((s) => s.round === ctx.round && s.op === "search" && s.ok && s.on)
      .map((s) => `${s.on}\u0000${s.source}`),
  );
  let written = 0;
  let calls = 0;
  let answered = 0;
  let transient: Transient | null = null;
  for (const q of queries) {
    const todo = searchers.filter((s) => !searched.has(`${q.id}\u0000${s.name}`));
    calls += todo.length;
    const got = gather(
      await Promise.allSettled(
        todo.map((s) =>
          ctx.invoke(s, "search", q.terms, q.id, () =>
            (s.search as NonNullable<Source["search"]>)(q),
          ),
        ),
      ),
    );
    transient ??= got.transient;
    const byKey = new Map<
      string,
      { hit: Parameters<typeof dedupeHits>[0][number]; by: string; from: From }
    >();
    for (const [i, hits] of got.values.entries()) {
      if (!hits) continue;
      answered++;
      const s = todo[i] as Source;
      for (const h of hits) {
        const key = canonical(h.url);
        const have = byKey.get(key);
        if (have) have.hit.sources = [...new Set([...(have.hit.sources ?? []), s.name])];
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
  if (transient && !answered) throw transient;
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
  let transient: Transient | null = null;
  /** The openers in order; the first document wins. A Transient from one leaves the next its turn. */
  const openOne = async (h: HitRecord) => {
    for (const s of openers) {
      try {
        const doc = await ctx.invoke(s, "open", h.url, h.id, () =>
          (s.open as NonNullable<Source["open"]>)(h),
        );
        if (doc) return { doc, source: s };
      } catch (err) {
        if (!(err instanceof Transient)) throw err;
        transient ??= err;
      }
    }
    return null;
  };
  let read = 0;
  await batched(hits, openOne, async (h, g) => {
    if (!g) return;
    await ctx.write(
      { type: "document", ...g.doc, hit: h.id },
      { from: g.source.from ?? "tool", by: g.source.by ?? g.source.name },
    );
    read++;
  });
  if (transient && !read) throw transient;
  return { ok: true, note: `${read} of ${hits.length} hits read` };
};

export const extractStep: StepFn = async (ctx, state) => {
  const docs = toExtract(state, ctx.round);
  if (!docs.length) return { ok: true, note: "nothing to extract" };
  if (!ctx.model) return { ok: false, note: "no model: nothing extracted" };
  const ask = state.snapshot?.ask;
  if (!ask) return { ok: false, note: "no snapshot" };
  const known = [...new Set([...ask.known, ...found(state)])];
  const extractOne = async (d: DocumentRecord) => {
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
    const model = ctx.modelOn(id) as Model;
    return { out: await ctx.deps.extractor.extract(doc, { text: ask.text, known }, model), model };
  };
  let proposed = 0;
  let dropped = 0;
  let done = 0;
  // Each document's findings and verdict land as its batch settles: a document whose extract
  // fails costs only itself. The verdict is the checkpoint: the documents without one are
  // extracted on the next try.
  const got = await batched(docs, extractOne, async (d, g) => {
    const who = { from: "ai" as const, by: g.model.id };
    for (const f of g.out.findings) await ctx.write({ type: "finding", ...f, document: d.id }, who);
    const { quality, gap } = g.out.verdict;
    await ctx.write({ type: "verdict", document: d.id, quality, ...(gap ? { gap } : {}) }, who);
    proposed += g.out.findings.length;
    dropped += g.out.dropped.length;
    done++;
  });
  if (got.transient) throw got.transient;
  return {
    ok: true,
    note: `${proposed} findings from ${done} documents, ${dropped} dropped at the gate`,
  };
};

export const reviewStep: StepFn = async (ctx, state) => {
  const p = planOf(state, ctx.round);
  const inRound = <T extends { round: number }>(r: T) => r.round === ctx.round;
  const hits = state.hits.filter(inRound).length;
  const reads = state.documents.filter(inRound).length;
  const proposed = state.findings.filter(inRound).length;
  const foundNow = found(state, ctx.round);
  const urlOf = new Map(state.documents.map((d) => [d.id, d.url]));
  const round = {
    ask: p.ask,
    round: ctx.round,
    budget: p.budget,
    hits,
    reads,
    proposed,
    kept: foundNow.length,
    found: foundNow,
    verdicts: state.verdicts.filter(inRound).map((v) => ({
      url: urlOf.get(v.document) ?? v.document,
      quality: v.quality,
      ...(v.gap ? { gap: v.gap } : {}),
    })),
    notes: [
      ...new Set(
        state.spends
          .filter((s) => inRound(s) && !s.ok)
          .map((s) => `${s.source} ${s.op} failed: ${s.error ?? "?"}`),
      ),
    ],
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
