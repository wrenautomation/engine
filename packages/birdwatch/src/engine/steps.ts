/**
 * The fixed steps the agent commands run: search, read, extract, check. A step reads the fold,
 * calls ports, and appends records; it holds nothing between calls. Source calls fan out (per query across
 * the searchers; reads and extracts a few at a time) and their records land in order, so a
 * trace reads the same whatever answered first. A step runs again after a transient failure
 * from where its records say it got to: a search with an ok spend, a hit with a document, a
 * document with a verdict, are not done twice.
 */

import { isTransient, type Model, Transient } from "@wrenautomation/models";
import type { EntryType, Judged, JudgeFailure, Questions } from "@wrenautomation/models/judge";
import { checkFinding, type Document, gateFindings } from "../document/index.js";
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
import { HitView, type HitViewIn } from "./types.js";
import { DOUBT, judgeDocuments, judgeFindings, judgeHits, passNote, yesOf } from "./judge.js";
import { type Deps, FOLLOW_N, pick, type Source, searchersFor } from "./ports.js";
import {
  fold,
  found,
  kept,
  type RunState,
  toExtract,
  toRead,
  uncalledHits,
} from "./state.js";
import {
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

/** The allow-list plus the openers let in to open and follow; one this machine lacks is skipped. */
const readersOf = (ctx: StepContext, state: RunState): Source[] => [
  ...sourcesOf(ctx, state),
  ...(state.snapshot?.opens ?? []).flatMap((n) => ctx.deps.sources.get(n) ?? []),
];

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

/** A line with a URL or a ledger id on it: a fact someone can go and check. */
export const sourced = (line: string): boolean =>
  /https?:\/\/\S|\b[0-9A-HJKMNP-TV-Z]{26}\b/.test(line);

/**
 * The ask with each known line that names no source moved to its premises. A run seeded with
 * "the buyer is X" plans inside X unless something tests X; a sourced line is looked past.
 */
export function withPremises<A extends { known?: readonly string[]; premises?: readonly string[] }>(
  ask: A,
): A & { known: string[]; premises: string[] } {
  const known = ask.known ?? [];
  return {
    ...ask,
    known: known.filter(sourced),
    premises: [...new Set([...(ask.premises ?? []), ...known.filter((l) => !sourced(l))])],
  };
}

/** One hit per url, sources merged, order of first sight. */
export function dedupeHits(hits: readonly HitViewIn[]): HitView[] {
  const byUrl = new Map<string, HitView>();
  for (const h of hits.map((x) => HitView.parse(x))) {
    const url = h.url.trim();
    const have = byUrl.get(url);
    if (!have) {
      byUrl.set(url, { ...h, url, sources: [...new Set(h.sources)] });
      continue;
    }
    for (const s of h.sources) if (!have.sources.includes(s)) have.sources.push(s);
    for (const k of ["title", "channel", "length", "date", "snippet"] as const) {
      if (have[k] === undefined && h[k] !== undefined) (have as Record<string, unknown>)[k] = h[k];
    }
  }
  return [...byUrl.values()];
}

/**
 * What a round's plan reads: the known lines (what
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

export const fetchStep: StepFn = async (ctx, state) => {
  const queries = state.queries.filter((q) => q.round === ctx.round);
  const searchers = sourcesOf(ctx, state);
  const followers = readersOf(ctx, state);
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
    if (r.type === "snapshot") list = new Set([...r.sources, ...r.opens]);
    else if (r.type === "query" && list) listOf.set(r.id, list);
  const idOf = new Map(state.hitByKey);
  let written = 0;
  let again = 0;
  let calls = 0;
  let answered = 0;
  let transient: Transient | null = null;
  for (const q of queries) {
    const todo = searchersFor(q.follow ? followers : searchers, q).filter(
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
    if (
      !searchersFor(q.follow ? followers : searchers, q).every((s) =>
        okOn.has(`${q.id}\u0000${s.name}`),
      )
    )
      continue;
    await ctx.write(
      { type: "gap", on: q.id, note: `query "${q.terms}": no new hits` },
      tool(ctx.deps.writer),
    );
    empty++;
  }
  const judged = await judgeHits(ctx, fold(ctx.run, await ctx.deps.ledger.trace(ctx.run)));
  return {
    ok: true,
    note: `${written} new hits${again ? `, ${again} found again,` : ""} from ${calls} searches${empty ? `, ${empty} queries with none` : ""}${passNote(judged)}`,
  };
};

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
  const listed = readersOf(ctx, state).filter((s) => s.open);
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
        tool(ctx.deps.writer),
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
