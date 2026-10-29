/**
 * The step table: one typed call per step, records in, records out. The runner interprets it in
 * order; wren's executor mounts the same table as stations. A step reads the fold, calls ports,
 * and appends records; it holds nothing between calls. Source calls fan out (per query across
 * the searchers; reads and extracts a few at a time) and their records land in order, so a
 * trace reads the same whatever answered first. A step runs again after a transient failure
 * from where its records say it got to: a search with an ok spend, a hit with a document, a
 * document with a verdict, are not done twice.
 */

import { checkFinding, type Document, gateFindings } from "@wrenautomation/falcon/document";
import { isTransient, type Model, Transient } from "@wrenautomation/models";
import type { EntryType, Judged, JudgeFailure, Questions } from "@wrenautomation/models/judge";
import {
  dedupeHits,
  defaultPlanFile,
  plan,
  review,
  triage,
  withPremises,
} from "@wrenautomation/raven";
import type {
  DocumentRecord,
  Envelope,
  FindingRecord,
  From,
  GapRecord,
  HitRecord,
  LedgerRecord,
  Step,
} from "../ledger/records.js";
import { canonical } from "./canonical.js";
import { DOUBT, judgeDocuments, judgeFindings, judgeHits, passNote, yesOf } from "./judge.js";
import { type Deps, FOLLOW_N, pick, type RunOptions, type Source, searchersFor } from "./ports.js";
import {
  fold,
  found,
  kept,
  planOf,
  type RunState,
  toCheck,
  toExtract,
  toRead,
  uncalledHits,
} from "./state.js";
import {
  budgetUnder,
  fromChildren,
  fromSiblings,
  linkTo,
  type Parent,
  treeReadsOf,
  treeRoom,
} from "./tree.js";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

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
  /**
   * One judge call with its spend written; its answers, or the failure's kind (`off`: no judge).
   * Never throws.
   */
  judge(
    on: string,
    about: string,
    state: EntryType,
    questions: Questions,
  ): Promise<Judged | { failure: JudgeFailure | "off" }>;
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

/** A gap as a prompt line: the step that wrote it, or the person. */
const gapLine = (g: GapRecord): string => `${g.step ?? g.by}: ${g.note}`;

/** A person's keep or drop on a finding of round `round`, as prompt lines: the finding, then why. */
const personCalls = (state: RunState, round: number): string[] => {
  const textOf = new Map(state.findings.map((f) => [f.id, f.text]));
  return state.calls
    .filter((c) => c.from === "human" && c.round === round && textOf.has(c.on))
    .map((c) => `${c.by} ${c.verdict}s "${textOf.get(c.on)}": ${c.why}`);
};

/**
 * What round `round` left open: its review's why when it said again, its gaps, and a person's
 * keep or drop on its findings (often written after the review, between rounds).
 */
export const openAfter = (state: RunState, round: number): string[] => {
  const edge = state.edges.filter((e) => e.round === round).at(-1);
  return [
    ...(edge?.next === "again" ? [edge.why] : []),
    ...state.gaps.filter((g) => g.round === round).map(gapLine),
    ...personCalls(state, round),
  ];
};

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
    if (isTransient(r.reason)) {
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
      else if (isTransient(r.reason)) transient ??= r.reason;
      else if (!anyFailed) {
        anyFailed = true;
        failed = r.reason;
      }
    }
    if (anyFailed) throw failed;
  }
  return { transient };
}

/**
 * What a round's plan reads, for the agent's plan and the runner's alike: the known lines (what
 * the ask brought, what the run kept, then what its children found), the premises, and what is
 * open (the last round's holes, children still going). A new child also reads what its parent
 * and siblings found.
 */
export async function planAsk(
  deps: Pick<Deps, "ledger">,
  state: RunState,
  base: { text: string; known?: readonly string[]; premises?: readonly string[] },
  round: number,
  parent?: Parent,
): Promise<{ known: string[]; premises: string[]; open: string[] }> {
  const { known, premises } = withPremises({
    known: [...new Set([...(base.known ?? []), ...found(state)])],
    premises: [...(base.premises ?? [])],
  });
  const children = await fromChildren(deps, state.run);
  const siblings = parent && round === 1 ? await fromSiblings(deps, parent.run, base.text) : [];
  return {
    known: [...new Set([...known, ...siblings, ...children.known])],
    premises,
    open: [...(round > 1 ? openAfter(state, round - 1) : []), ...children.open],
  };
}

export const planStep: StepFn = async (ctx, state) => {
  const ask = state.snapshot?.ask ?? ctx.options.ask;
  if (!ask) return { ok: false, note: "no ask: a new run needs one" };
  const planFile = ctx.options.planFile ?? defaultPlanFile(ask.kind);
  const yieldRows = await ctx.deps.ledger.yield();
  // A resume passes the same options: only a new run links; later rounds take the snapshot's.
  const asked = state.snapshot ? undefined : ctx.options.parent;
  const link = asked ? await linkTo(ctx.deps, asked, planFile) : null;
  const parent = link?.parent ?? state.snapshot?.parent;
  const { known, premises, open } = await planAsk(ctx.deps, state, ask, ctx.round, parent);
  const steer = [...new Set([...(ask.steer ?? []), ...state.steers.map((s) => s.text)])];
  const p = await plan({
    ask: { ...ask, known, premises, steer, open, criteria: ask.criteria ?? [] },
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
    {
      type: "snapshot",
      ask: p.ask,
      sources: p.sources,
      budget: await budgetUnder(ctx.deps, parent, p.budget),
      ...snapshot,
      ...(parent ? { parent } : { treeReads: treeReadsOf(planFile, p.budget) }),
    },
    tool(ctx.deps.runner),
  );
  for (const { from, by, ...q } of p.queries)
    await ctx.write({ type: "query", ...q }, { from, by });
  const warned = link?.warnings.length ? `; ${link.warnings.join("; ")}` : "";
  return p.queries.length
    ? { ok: true, note: `${p.queries.length} queries over ${p.sources.join(", ")}${warned}` }
    : { ok: false, note: "no queries: nothing proposed" };
};

export const fetchStep: StepFn = async (ctx, state) => {
  const queries = state.queries.filter((q) => q.round === ctx.round);
  const searchers = sourcesOf(ctx, state);
  if (!searchers.some((s) => s.search) && !queries.some((q) => q.follow))
    return { ok: false, note: "no search source in the allow-list" };
  const searched = new Set(
    state.spends
      .filter((s) => s.round === ctx.round && s.op === "search" && s.ok && s.on)
      .map((s) => `${s.on}\u0000${s.source}`),
  );
  // Each query goes to the allow-list as it stood when it was written: a source a later
  // `--with` let in does not run the earlier queries.
  const listOf = new Map<string, Set<string>>();
  let list: Set<string> | null = null;
  for (const r of state.records)
    if (r.type === "snapshot") list = new Set(r.sources);
    else if (r.type === "query" && list) listOf.set(r.id, list);
  const idOf = new Map(state.hitByKey);
  let written = 0;
  let again = 0;
  let calls = 0;
  let answered = 0;
  let transient: Transient | null = null;
  for (const q of queries) {
    const todo = searchersFor(searchers, q).filter(
      (s) => !searched.has(`${q.id}\u0000${s.name}`) && (listOf.get(q.id)?.has(s.name) ?? true),
    );
    calls += todo.length;
    const got = gather(
      await Promise.allSettled(
        todo.map((s) =>
          ctx.invoke(s, "search", q.terms, q.id, () =>
            q.follow
              ? (s.follow as NonNullable<Source["follow"]>)(q.follow.as, q.follow.url, FOLLOW_N)
              : (s.search as NonNullable<Source["search"]>)(q),
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
      const known = idOf.get(key);
      if (known) {
        await ctx.write({ type: "found", hit: known, query: q.id }, { from, by });
        again++;
        continue;
      }
      const [view] = dedupeHits([hit]);
      if (!view) continue;
      idOf.set(key, await ctx.write({ type: "hit", ...view, key, queries: [q.id] }, { from, by }));
      written++;
    }
  }
  if (transient && !answered) throw transient;
  // A query every searcher answered with no new hit is a gap: read from the records, so a
  // rerun after a Transient neither repeats one nor writes one for a query it skipped.
  const after = await ctx.deps.ledger.trace(ctx.run);
  const okOn = new Set(
    after
      .filter((r) => r.type === "spend" && r.op === "search" && r.ok && r.round === ctx.round)
      .map((r) => `${(r as { on?: string }).on}\u0000${(r as { source: string }).source}`),
  );
  const hitOn = new Set(
    after.flatMap((r) => (r.type === "hit" ? r.queries : r.type === "found" ? [r.query] : [])),
  );
  const gapOn = new Set(after.flatMap((r) => (r.type === "gap" && r.on ? [r.on] : [])));
  let empty = 0;
  for (const q of queries) {
    // A tree's query is thin, not a gap: the tree says so when a facet's every try came up empty.
    if (q.facet || hitOn.has(q.id) || gapOn.has(q.id)) continue;
    if (!searchersFor(searchers, q).every((s) => okOn.has(`${q.id}\u0000${s.name}`))) continue;
    await ctx.write(
      { type: "gap", on: q.id, note: `query "${q.terms}": no new hits` },
      tool(ctx.deps.runner),
    );
    empty++;
  }
  const judged = await judgeHits(ctx, fold(ctx.run, await ctx.deps.ledger.trace(ctx.run)));
  return {
    ok: true,
    note: `${written} new hits${again ? `, ${again} found again,` : ""} from ${calls} searches${empty ? `, ${empty} queries with none` : ""}${passNote(judged)}`,
  };
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
    }) => {
      // Jev's yes on serves and each criterion: a hint the model sees, never the call
      const odds = ["serves", ...(p.ask.criteria ?? []).map((c) => c.name)].flatMap((q) => {
        const yes = yesOf(state, _i, q);
        return yes === undefined ? [] : [[q, yes] as const];
      });
      return odds.length ? { ...view, odds: Object.fromEntries(odds) } : view;
    },
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

export const readStep: StepFn = (ctx, state) => readHits(ctx, state, toRead(state, ctx.round));

/** Opens `hits`, each by the first opener that has it; the agent's `open` passes its own list. */
export async function readHits(
  ctx: StepContext,
  state: RunState,
  wanted: readonly HitRecord[],
): Promise<StepResult> {
  // The tree's cap is the one hard stop on reads.
  const room = wanted.length ? await treeRoom(ctx.deps, ctx.run) : null;
  if (room && !room.left)
    return {
      ok: false,
      note: `the tree under ${room.root} read ${room.read} pages, its cap ${room.cap}: stop a run, or plan a new root with a higher runs.reads`,
    };
  const hits = room ? wanted.slice(0, room.left) : wanted;
  const capped =
    hits.length < wanted.length ? `; the tree's cap left ${hits.length} of ${wanted.length}` : "";
  const listed = sourcesOf(ctx, state).filter((s) => s.open);
  // A site's own reader before the general openers; the allow-list's order inside each.
  const openers = [...listed.filter((s) => s.first), ...listed.filter((s) => !s.first)];
  if (hits.length && !openers.length)
    return { ok: false, note: "no open source in the allow-list" };
  let transient: Transient | null = null;
  /**
   * The openers that claim the URL, in order; the first document wins. A miss (the source threw:
   * a 403, a block) has its spend `ok: false` and leaves the next its turn, its reason kept for
   * the gap. A Transient leaves it to the next try. No document and no Transient: `missed`, so
   * the hit is a gap.
   */
  const openOne = async (
    h: HitRecord,
  ): Promise<{ doc: Document; source: Source } | { missed: string[] | null }> => {
    const why: string[] = [];
    let retrying = false;
    for (const s of openers) {
      if (s.opens && !s.opens(h.url)) continue;
      try {
        const doc = await ctx.invoke(s, "open", h.url, h.id, () =>
          (s.open as NonNullable<Source["open"]>)(h).catch((err: unknown) => {
            if (!isTransient(err)) why.push(`${s.name}: ${message(err)}`);
            throw err;
          }),
        );
        if (doc) return { doc, source: s };
      } catch (err) {
        if (!isTransient(err)) throw err;
        transient ??= err;
        retrying = true;
      }
    }
    return { missed: retrying ? null : why };
  };
  const gapOn = new Set(state.gaps.map((g) => g.on));
  let read = 0;
  let missed = 0;
  await batched([...hits], openOne, async (h, g) => {
    if (!("doc" in g)) {
      if (!g.missed || gapOn.has(h.id)) return;
      const why = g.missed.length ? `: ${g.missed.join("; ")}` : "";
      await ctx.write(
        { type: "gap", on: h.id, note: `no source could open ${h.url}${why}` },
        tool(ctx.deps.runner),
      );
      missed++;
      return;
    }
    await ctx.write(
      { type: "document", ...g.doc, hit: h.id },
      { from: g.source.from ?? "tool", by: g.source.by ?? g.source.name },
    );
    read++;
  });
  if (transient && !read) throw transient;
  // Openers this machine has outside the run's allow-list: the agent can let them in.
  const allowed = new Set(openers.map((s) => s.name));
  const outside = [...ctx.deps.sources.values()].filter((s) => s.open && !allowed.has(s.name));
  const hint =
    missed && outside.length
      ? `; not in the allow-list: ${outside.map((s) => s.name).join(", ")} (open --with)`
      : "";
  const judged = read
    ? await judgeDocuments(ctx, fold(ctx.run, await ctx.deps.ledger.trace(ctx.run)))
    : { judged: 0, failed: 0 };
  return {
    ok: true,
    note: `${read} of ${hits.length} hits read${missed ? `, ${missed} no source could open` : ""}${capped}${hint}${passNote(judged)}`,
  };
}

export const extractStep: StepFn = (ctx, state) =>
  extractDocuments(ctx, state, toExtract(state, ctx.round));

/** A transient stop that says what the step finished first: the next try does only the rest. */
const stopped = (t: Transient, finished: string) =>
  new Transient(`${t.message} (${finished} before it stopped; run the step again for the rest)`, {
    retryAfter: t.retryAfter,
    ...(t.status === undefined ? {} : { status: t.status }),
    cause: t,
  });

/** Extracts `docs` with the extractor on the run's model; the agent's `extract` passes its own list. */
export async function extractDocuments(
  ctx: StepContext,
  state: RunState,
  docs: readonly DocumentRecord[],
): Promise<StepResult> {
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
    return {
      out: await ctx.deps.extractor.extract(
        doc,
        { text: ask.text, known, steer: ask.steer },
        model,
      ),
      model,
    };
  };
  let proposed = 0;
  let dropped = 0;
  let done = 0;
  let continued = 0;
  // Each document's findings and verdict land as its batch settles: a document whose extract
  // fails costs only itself. The verdict is the checkpoint: the documents without one are
  // extracted on the next try.
  const got = await batched([...docs], extractOne, async (d, g) => {
    const who = { from: "ai" as const, by: g.model.id };
    for (const f of g.out.findings)
      await ctx.write(
        { type: "finding", ...f, document: d.id, ...(d.date ? { date: d.date } : {}) },
        who,
      );
    const { quality, gap } = g.out.verdict;
    await ctx.write({ type: "verdict", document: d.id, quality, ...(gap ? { gap } : {}) }, who);
    proposed += g.out.findings.length;
    dropped += g.out.dropped.length;
    continued += g.out.continued ?? 0;
    done++;
  });
  if (got.transient)
    throw stopped(got.transient, `${proposed} findings from ${done} of ${docs.length} documents`);
  return {
    ok: true,
    note: `${proposed} findings from ${done} documents, ${dropped} dropped at the gate${continued ? `, ${continued} cut answers continued` : ""}`,
  };
}

/**
 * The sample check: a few kept findings, spread across the round's documents, each read by a
 * model against its document. A finding whose quote does not back it gets a check record and a
 * drop call; one that holds gets a check record. The share that fails is the review's read on
 * the extract. A check record is the checkpoint: a rerun checks only the rest of the sample.
 */
export const checkStep: StepFn = (ctx, state) =>
  checkSample(ctx, state, toCheck(state, ctx.round, planOf(state, ctx.round).budget.checks));

/**
 * Checks `findings` against their documents; the agent's `check` passes its own sample. The
 * judge first reads every kept, unchecked finding with a quote; each one it doubts joins the
 * sample. A judge's yes never takes a finding out of it. A fail's fix (a narrower sentence on
 * the same quote) passes the gate and a second check before it lands as a new finding.
 */
export async function checkSample(
  ctx: StepContext,
  state: RunState,
  sample: readonly FindingRecord[],
): Promise<StepResult> {
  const checked = new Set(state.checks.map((c) => c.on));
  const pool = state.findings.filter((f) => f.proof.quote && kept(state, f) && !checked.has(f.id));
  const judged = await judgeFindings(ctx, state, pool);
  const now = judged.judged ? fold(ctx.run, await ctx.deps.ledger.trace(ctx.run)) : state;
  const inSample = new Set(sample.map((f) => f.id));
  const doubted = pool.filter(
    (f) => !inSample.has(f.id) && (yesOf(now, f.id, "backs") ?? 1) < DOUBT,
  );
  const findings = [...sample, ...doubted];
  const judgeNote = passNote(judged);
  if (!findings.length) return { ok: true, note: `nothing to check${judgeNote}` };
  if (!ctx.model) return { ok: true, note: `no model: no checks${judgeNote}` };
  const docs = new Map(state.documents.map((d) => [d.id, d]));
  const checkOne = async (f: (typeof findings)[number]) => {
    const d = docs.get(f.document);
    if (!d) throw new Error(`finding ${f.id}: no document ${f.document}`);
    const model = ctx.modelOn(f.id) as Model;
    return { out: await checkFinding(f, d, model), model };
  };
  let ok = 0;
  let failed = 0;
  let fixed = 0;
  /** The fix as a finding when the gate passes it and a second check backs it. */
  const repair = async (f: FindingRecord, fix: string, model: Model) => {
    const d = docs.get(f.document) as DocumentRecord;
    const gated = gateFindings({ findings: [{ text: fix, quote: f.proof.quote ?? "" }] }, d)
      .findings[0];
    if (!gated) return;
    const again = await checkFinding(gated, d, model).catch(() => null);
    if (!again) return;
    const who = { from: "ai" as const, by: model.id };
    const id = await ctx.write(
      {
        type: "finding",
        ...gated,
        document: d.id,
        ...(f.date ? { date: f.date } : {}),
        fixes: f.id,
      },
      who,
    );
    await ctx.write({ type: "check", on: id, ok: again.ok, why: again.why }, who);
    if (again.ok) fixed++;
    else await ctx.write({ type: "call", on: id, verdict: "drop", why: again.why }, who);
  };
  const got = await batched([...findings], checkOne, async (f, g) => {
    if (!g.out) return;
    const who = { from: "ai" as const, by: g.model.id };
    await ctx.write({ type: "check", on: f.id, ok: g.out.ok, why: g.out.why }, who);
    if (g.out.ok) ok++;
    else {
      await ctx.write({ type: "call", on: f.id, verdict: "drop", why: g.out.why }, who);
      failed++;
      if (g.out.fix) await repair(f, g.out.fix, g.model);
    }
  });
  if (got.transient) throw stopped(got.transient, `${ok + failed} of ${sample.length} checks done`);
  const why = doubted.length
    ? ` (${sample.length} sampled, ${doubted.length} the judge doubted)`
    : "";
  return {
    ok: true,
    note: `${ok + failed} checked${why}, ${failed} not backed by their quote${fixed ? ` (${fixed} fixed: a narrower sentence on the same quote)` : ""}${judgeNote}`,
  };
}

export const reviewStep: StepFn = async (ctx, state) => {
  const p = planOf(state, ctx.round);
  const inRound = <T extends { round: number }>(r: T) => r.round === ctx.round;
  const hits = state.hits.filter(inRound).length;
  const reads = state.documents.filter(inRound).length;
  const proposed = state.findings.filter(inRound).length;
  const foundNow = found(state, ctx.round);
  const dated = state.findings
    .filter((f) => inRound(f) && kept(state, f))
    .map((f) => (f.date ? `${f.text} [${f.date}]` : f.text));
  const textOf = new Map(state.findings.map((f) => [f.id, f.text]));
  const urlOf = new Map(state.documents.map((d) => [d.id, d.url]));
  const round = {
    ask: p.ask,
    round: ctx.round,
    budget: p.budget,
    hits,
    reads,
    proposed,
    kept: foundNow.length,
    found: dated,
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
      ...personCalls(state, ctx.round),
    ],
    gaps: state.gaps.filter(inRound).map(gapLine),
    checks: state.checks
      .filter(inRound)
      .map((c) => `${c.ok ? "ok" : "failed"}: ${textOf.get(c.on) ?? c.on} (${c.why})`),
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
  check: checkStep,
  review: reviewStep,
};
