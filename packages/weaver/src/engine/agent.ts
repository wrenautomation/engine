/**
 * The engine driven by an agent: each step as one call over a run's ledger. Claude Code (or any
 * agent) plans, triages, reviews and stops in its own head; the engine does the fixed work
 * (search, open, extract through the quote gate, check) and keeps the records. Every record the
 * agent writes carries its id and, on a decision, a why; the person's words come through it
 * marked `from: human`. The runner loops over the same step functions, so `weaver run --resume`
 * can take a run over, and the fold reads both the same. The budget is a guard rail here: the
 * brief shows it, nothing cuts a query or stops a round by it.
 */
import { type ClaimAnswer, gateFindings, patternOf } from "@wrenautomation/falcon/document";
import { gateDrafts, type NumberedClaim } from "@wrenautomation/falcon/study";
import { isTransient } from "@wrenautomation/models";
import {
  type AskKind,
  defaultPlanFile,
  type Edge,
  PlanFile,
  QueryTree,
  type TreeGuide,
  treeOf,
  type YieldRow,
} from "@wrenautomation/raven";
import {
  type DocumentRecord,
  type DraftRecord,
  type Envelope,
  type From,
  type HitRecord,
  LedgerRecord,
  SOURCE_CLASSES,
  type SourceClass,
  type Step,
} from "../ledger/records.js";
import { canonical } from "./canonical.js";
import { costOf } from "./cost.js";
import { classGuess, type JudgeStats, judgeStats, pickOf, yesOf } from "./judge.js";
import type { Deps } from "./ports.js";
import { context } from "./runner.js";
import {
  checkCount,
  classesOf,
  echoOf,
  fold,
  kept,
  type Pointer,
  personRound,
  queriesOf,
  type RunState,
  sourcesOf,
  spreadSample,
} from "./state.js";
import {
  checkSample,
  extractDocuments,
  fetchStep,
  openAfter,
  planAsk,
  readHits,
  type StepFn,
  type StepResult,
} from "./steps.js";
import { budgetUnder, type ChildView, linkTo, runTree } from "./tree.js";

/** Who a record is from: the agent (`ai`, its id) or the person through it (`human`, their name). */
export interface Who {
  from: From;
  by: string;
}

/** What one command did: the step's word and every record it wrote, in order. */
export interface Did {
  run: string;
  round: number;
  step: Step;
  ok: boolean;
  note?: string;
  wrote: Shown[];
}

/** A record as a command prints it: a document's text replaced by its length. */
export type Shown = LedgerRecord | (Omit<DocumentRecord, "text"> & { chars: number });

export const shown = (r: LedgerRecord): Shown => {
  if (r.type !== "document") return r;
  const { text, ...rest } = r;
  return { ...rest, chars: text.length };
};

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function stateOf(deps: Deps, run: string): Promise<RunState> {
  const state = fold(run, await deps.ledger.trace(run));
  if (!state.records.length) throw new Error(`run ${run}: no records`);
  return state;
}

/** The round's snapshot is every step's precondition. */
function planned(state: RunState): void {
  if (state.snapshot?.round !== state.round)
    throw new Error(`run ${state.run}: round ${state.round} has no plan: weaver plan --run first`);
}

const tool = (deps: Deps) => ({ from: "tool" as const, by: deps.runner });

/** One step over the run as the runner runs it: the fold, the step, its `done`, the fold again. */
async function stepRun(deps: Deps, run: string, step: Step, fn: StepFn): Promise<Did> {
  const state = await stateOf(deps, run);
  planned(state);
  const before = new Set(state.records.map((r) => r.id));
  const ctx = context(deps, {}, run, state.round, step);
  let result: StepResult;
  try {
    result = await fn(ctx, state);
  } catch (err) {
    if (isTransient(err)) throw err;
    result = { ok: false, note: message(err) };
  }
  await ctx.write(
    { type: "done", step, ok: result.ok, ...(result.note ? { note: result.note } : {}) },
    tool(deps),
  );
  const after = await deps.ledger.trace(run);
  return {
    run,
    round: state.round,
    step,
    ok: result.ok,
    ...(result.note ? { note: result.note } : {}),
    wrote: after.filter((r) => !before.has(r.id)).map(shown),
  };
}

export interface AskInput {
  text: string;
  kind: AskKind;
  known?: readonly string[];
  /** What the ask takes as given: the tree tests each in a `premise` facet. */
  premises?: readonly string[];
  site?: string;
}

export interface PlanInput {
  /** Absent: a new run. Present: the next round of it, after an edge that said again. */
  run?: string;
  /** A new run's ask; a later round takes the last snapshot's. */
  ask?: AskInput;
  /** Its `sources` are the run's allow-list, every name one this machine has. */
  planFile: PlanFile;
  /** The model id the extract will use, for the snapshot; null when none. */
  model: string | null;
  /** A new run's parent, and why this child. */
  parent?: { run: string; why: string };
}

/**
 * Opens a round: writes its snapshot (the ask, with what is known and what the last round left
 * open, the allow-list, the budget) and the plan step's `done`. No queries: the agent's come
 * through `search`, never capped.
 */
export async function planRound(deps: Deps, input: PlanInput): Promise<Did> {
  const run = input.run ?? deps.ids();
  const state = fold(run, await deps.ledger.trace(run));
  if (input.run && !state.records.length) throw new Error(`run ${run}: no records`);
  const round = state.round;
  if (state.snapshot?.round === round)
    throw new Error(
      state.next
        ? `run ${run}: round ${round} is planned`
        : `run ${run}: stopped after round ${round}; weaver add edge again opens the next`,
    );
  const last = state.snapshot?.ask;
  const base = last ?? input.ask;
  if (!base) throw new Error("a new run needs an ask");
  for (const name of input.planFile.sources)
    if (!deps.sources.has(name)) throw new Error(`no source named ${name}`);
  if (input.parent && state.snapshot) throw new Error("--parent: only a new run");
  const link = input.parent ? await linkTo(deps, input.parent, input.planFile) : null;
  const parent = link?.parent ?? state.snapshot?.parent;
  const { known, premises, open } = await planAsk(deps, state, base, round, parent);
  const ask = {
    text: base.text,
    kind: base.kind,
    known,
    premises,
    steer: [...new Set([...(last?.steer ?? []), ...state.steers.map((s) => s.text)])],
    open,
    ...(base.site ? { site: base.site } : {}),
  };
  const yieldRows = await deps.ledger.yield();
  const ctx = context(deps, { planFile: input.planFile }, run, round, "plan");
  await ctx.write(
    {
      type: "snapshot",
      ask,
      sources: input.planFile.sources,
      budget: await budgetUnder(deps, parent, input.planFile.budget),
      known: ask.known,
      planFile: { id: input.planFile.id, version: input.planFile.version },
      model: input.model,
      yieldRows: yieldRows.length,
      ...(parent ? { parent } : {}),
    },
    tool(deps),
  );
  const note = [
    `round ${round} over ${input.planFile.sources.join(", ")}; search next`,
    ...(link?.warnings ?? []),
  ].join("; ");
  await ctx.write({ type: "done", step: "plan", ok: true, note }, tool(deps));
  const after = await deps.ledger.trace(run);
  return {
    run,
    round,
    step: "plan",
    ok: true,
    note,
    wrote: after.filter((r) => r.round === round && r.step === "plan").map(shown),
  };
}

export interface QueryInput {
  terms: string;
  why: string;
  site?: string;
  /** The tree's facet it serves, when the agent adds one more leaf by hand. */
  facet?: string;
}

/** Writes the agent's queries, then runs the fetch step: every searcher on every unsearched query of the round. */
export async function search(
  deps: Deps,
  run: string,
  queries: readonly QueryInput[],
  who: Who,
): Promise<Did> {
  const state = await stateOf(deps, run);
  planned(state);
  const kind = (state.snapshot as NonNullable<RunState["snapshot"]>).ask.kind;
  const ctx = context(deps, {}, run, state.round, "plan");
  for (const q of queries) {
    const terms = q.terms.replace(/\s+/g, " ").trim();
    if (!terms) throw new Error("a query needs terms");
    if (!q.why.trim()) throw new Error(`query "${terms}": why?`);
    await ctx.write(
      {
        type: "query",
        kind,
        terms,
        why: q.why,
        ...(q.site ? { site: q.site } : {}),
        ...(q.facet ? { facet: q.facet } : {}),
      },
      who,
    );
  }
  return stepRun(deps, run, "fetch", fetchStep);
}

/** One try of a facet as the brief shows it: its queries, each with the hits it wrote and the known ones it found again. */
export interface TryView {
  tier: number;
  queries: { id: string; terms: string; hits: number; again: number }[];
  /** New hits the try wrote, summed. */
  hits: number;
}

export interface FacetView {
  name: string;
  tries: TryView[];
  /** New hits over every try. */
  hits: number;
  /** Hits a query of this facet found (written or found again) that triage kept. */
  kept: number;
  /** Hits of this facet no call has named yet: the next try waits on them. */
  uncalled: number;
  /** The facet reached the guide's `thin` in kept hits: no more tries. */
  enough: boolean;
  /** The source classes it needs, as its queries say. */
  needs: string[];
  /** Kept hits whose class (the agent's, else the judge's guess) is one it needs. */
  fit: number;
  /** Kept hits with any class known or guessed: `fit` counts only when one is. */
  guessed: number;
  /** Read pages with a kept finding, per class. */
  classes: Partial<Record<SourceClass | "unclassed", number>>;
  /** It needs classes; pages were read and none is of one. */
  lacks: boolean;
}

export interface TreeView {
  thin: number;
  facets: FacetView[];
  /** Facets the guide names that no query of the round served, dead ones left out. */
  uncovered: string[];
  /** Facets the agent gave up on: no try runs for them again. */
  dead: string[];
}

/** The round's queries by facet and try, with what each wrote and what triage kept: rebuilt from the records. */
export function treeView(state: RunState, round: number, guide: TreeGuide): TreeView {
  const hitsOf = new Map<string, number>();
  const againOf = new Map<string, number>();
  for (const h of state.hits) for (const q of h.queries) hitsOf.set(q, (hitsOf.get(q) ?? 0) + 1);
  for (const f of state.founds) againOf.set(f.query, (againOf.get(f.query) ?? 0) + 1);
  const facets: FacetView[] = [];
  const queryFacet = new Map<string, string>();
  for (const q of state.queries) {
    if (q.round !== round || !q.facet) continue;
    queryFacet.set(q.id, q.facet);
    let facet = facets.find((f) => f.name === q.facet);
    if (!facet) {
      facet = {
        name: q.facet,
        tries: [],
        hits: 0,
        kept: 0,
        uncalled: 0,
        enough: false,
        needs: [],
        fit: 0,
        guessed: 0,
        classes: {},
        lacks: false,
      };
      facets.push(facet);
    }
    for (const n of q.needs ?? []) if (!facet.needs.includes(n)) facet.needs.push(n);
    const tier = q.tier ?? 1;
    let t = facet.tries.find((x) => x.tier === tier);
    if (!t) {
      t = { tier, queries: [], hits: 0 };
      facet.tries.push(t);
    }
    const hits = hitsOf.get(q.id) ?? 0;
    t.queries.push({ id: q.id, terms: q.terms, hits, again: againOf.get(q.id) ?? 0 });
    t.hits += hits;
    facet.hits += hits;
  }
  // A hit counts for every facet whose query found it: a page two facets reached is kept for both.
  const facetsOf = new Map<string, Set<string>>();
  for (const [hit, queries] of queriesOf(state)) {
    const names = new Set([...queries].flatMap((q) => queryFacet.get(q) ?? []));
    facetsOf.set(hit, names);
    const call = state.called.get(hit);
    const guess = call === "keep" ? classGuess(state, hit) : undefined;
    for (const name of names) {
      const facet = facets.find((f) => f.name === name) as FacetView;
      if (call === "keep") {
        facet.kept++;
        if (guess) facet.guessed++;
        if (guess && facet.needs.includes(guess)) facet.fit++;
      } else if (!call) facet.uncalled++;
    }
  }
  const yielded = new Set(state.findings.filter((f) => kept(state, f)).map((f) => f.document));
  for (const d of state.documents) {
    if (!yielded.has(d.id)) continue;
    const c = state.classOf.get(d.id) ?? "unclassed";
    for (const name of facetsOf.get(d.hit) ?? []) {
      const facet = facets.find((f) => f.name === name) as FacetView;
      facet.classes[c] = (facet.classes[c] ?? 0) + 1;
    }
  }
  for (const f of facets) {
    f.tries.sort((a, b) => a.tier - b.tier);
    // A facet that needs classes is enough only with one kept hit of them, once any class is known.
    f.enough = f.kept >= guide.thin && (!f.needs.length || !f.guessed || f.fit > 0);
    f.lacks =
      f.needs.length > 0 &&
      Object.keys(f.classes).length > 0 &&
      !f.needs.some((n) => f.classes[n as SourceClass]);
  }
  const served = new Set(facets.map((f) => f.name));
  const dead = state.dead.map((d) => d.facet);
  return {
    thin: guide.thin,
    facets,
    uncovered: guide.facets.map((f) => f.name).filter((n) => !served.has(n) && !dead.includes(n)),
    dead,
  };
}

/**
 * The guide a run's tree runs under: the kind's stored plan file, else its default. An ask with
 * premises adds a facet that tests them, so the tree says when no query did.
 */
async function guideOf(
  deps: Deps,
  ask: { kind: AskKind; premises?: readonly string[] },
): Promise<TreeGuide> {
  const guide = treeOf((await deps.ledger.readPlan?.(ask.kind)) ?? defaultPlanFile(ask.kind));
  return ask.premises?.length ? { ...guide, facets: [...guide.facets, PREMISE_FACET] } : guide;
}

const PREMISE_FACET = {
  name: "premise",
  why: "test what the ask or the known list takes as given: does it hold?",
};

export interface TreeDid extends Did {
  tree: TreeView;
}

export interface TreeOptions {
  /** The next try of every facet that has one, whatever triage kept: no thin rule, no wait. */
  all?: boolean;
}

/**
 * One tier of the round's query tree: for each facet in the tree, its next try, in one fetch.
 * A facet with no query yet this round runs its first try. A facet that ran one waits for
 * triage (a call on each of its hits); then, under the guide's `thin` in kept hits, it runs the
 * next try; at `thin` it is done; out of tries, it is a gap. So the agent runs the same tree
 * again after each triage, and the tree falls through on what the agent kept, never on what a
 * searcher returned (every searcher returns a page). `all` runs every facet's next try at once.
 * A page two facets reached is a `found` on the first facet's hit, and the brief ranks it above
 * one facet's. Never capped: the agent wrote the tree.
 */
export async function searchTree(
  deps: Deps,
  run: string,
  tree: QueryTree,
  who: Who,
  options: TreeOptions = {},
): Promise<TreeDid> {
  QueryTree.parse(tree);
  const first = await stateOf(deps, run);
  planned(first);
  const ask = (first.snapshot as NonNullable<RunState["snapshot"]>).ask;
  const round = first.round;
  const guide = await guideOf(deps, ask);
  const names = new Set<string>();
  for (const f of tree.facets) {
    if (names.has(f.name)) throw new Error(`facet "${f.name}" twice`);
    names.add(f.name);
    for (const n of f.needs ?? [])
      if (!(SOURCE_CLASSES as readonly string[]).includes(n))
        throw new Error(`facet "${f.name}" needs ${n}: not one of ${SOURCE_CLASSES.join(", ")}`);
  }
  const before = treeView(first, round, guide);
  const wrote: Shown[] = [];
  const lines: string[] = [];
  const ctx = context(deps, {}, run, round, "plan");
  const ids: string[] = [];
  for (const facet of tree.facets) {
    if (before.dead.includes(facet.name)) {
      lines.push(`${facet.name}: dead`);
      continue;
    }
    const ran = before.facets.find((f) => f.name === facet.name);
    const sites = new Set(facet.tries.flat().map((l) => l.site ?? ""));
    if (sites.size === 1 && !sites.has(""))
      lines.push(`${facet.name}: every try pins ${[...sites][0]}, one source class at most`);
    if (ran?.lacks)
      lines.push(
        `${facet.name}: needs ${ran.needs.join(" or ")}, read pages are ${Object.keys(ran.classes).join(", ")}`,
      );
    const tier = (ran?.tries.at(-1)?.tier ?? 0) + 1;
    const next = facet.tries[tier - 1];
    if (ran && !options.all) {
      if (ran.enough) {
        lines.push(`${facet.name}: ${ran.kept} kept, enough`);
        continue;
      }
      if (ran.uncalled) {
        lines.push(`${facet.name}: ${ran.uncalled} uncalled, triage first`);
        continue;
      }
    }
    if (!next) {
      const note = `facet "${facet.name}": ${ran?.kept ?? 0} kept in ${tier - 1} ${tier === 2 ? "try" : "tries"}, none left`;
      if (ran && !ran.enough && !first.gaps.some((g) => g.round === round && g.note === note)) {
        const fetch = context(deps, {}, run, round, "fetch");
        const id = await fetch.write({ type: "gap", note }, { from: "tool", by: deps.runner });
        const trace = await deps.ledger.trace(run);
        wrote.push(shown(trace.find((r) => r.id === id) as LedgerRecord));
      }
      lines.push(`${facet.name}: out of tries`);
      continue;
    }
    for (const leaf of next) {
      const terms = leaf.terms.replace(/\s+/g, " ").trim();
      if (!terms) throw new Error(`facet "${facet.name}": a query needs terms`);
      if (!leaf.why.trim()) throw new Error(`query "${terms}": why?`);
      ids.push(
        await ctx.write(
          {
            type: "query",
            kind: ask.kind,
            terms,
            why: leaf.why,
            facet: facet.name,
            tier,
            ...(leaf.site ? { site: leaf.site } : {}),
            ...(facet.needs?.length ? { needs: facet.needs } : {}),
          },
          who,
        ),
      );
    }
    const unfit =
      ran && ran.kept >= before.thin && !ran.enough
        ? `, none of them ${ran.needs.join(" or ")}`
        : "";
    lines.push(`${facet.name}: try ${tier}${ran ? ` (${ran.kept} kept${unfit})` : ""}`);
  }
  if (!ids.length) {
    const end = await stateOf(deps, run);
    return {
      run,
      round,
      step: "fetch",
      ok: false,
      wrote,
      note: `nothing to search; ${lines.join("; ")}`,
      tree: treeView(end, round, guide),
    };
  }
  const trace = await deps.ledger.trace(run);
  for (const id of ids) wrote.push(shown(trace.find((r) => r.id === id) as LedgerRecord));
  const did = await stepRun(deps, run, "fetch", fetchStep);
  wrote.push(...did.wrote);
  const end = await stateOf(deps, run);
  const view = treeView(end, round, guide);
  const uncovered = view.uncovered.length ? `; not covered: ${view.uncovered.join(", ")}` : "";
  return {
    ...did,
    wrote,
    note: `${did.note ?? ""}; ${lines.join("; ")}${uncovered}`,
    tree: view,
  };
}

export interface OpenInput {
  /** Hits to keep (a call in the agent's name) and read. */
  hits?: readonly string[];
  /** Pages the agent names itself: a hit each, kept and read. */
  urls?: readonly string[];
  /** Why these: required with `hits` or `urls`. */
  why?: string;
  /**
   * Open sources this machine has that the run's allow-list lacks (a ladder that came after the
   * plan). Written as a new snapshot in the agent's name, so the ledger says when the list grew.
   */
  with?: readonly string[];
}

/** Kept hits of any round with no document yet. */
export const unread = (state: RunState): HitRecord[] => {
  const read = new Set(state.documents.map((d) => d.hit));
  return state.hits.filter((h) => state.called.get(h.id) === "keep" && !read.has(h.id));
};

/**
 * Keeps the hits named (and writes a hit per URL named), then runs the read step over every
 * kept hit of the run that has no document. No names: the reads alone.
 */
export async function open(deps: Deps, run: string, input: OpenInput, who: Who): Promise<Did> {
  const state = await stateOf(deps, run);
  planned(state);
  const named = [...(input.hits ?? [])];
  if ((named.length || input.urls?.length) && !input.why?.trim())
    throw new Error("open: why read these?");
  const ids = new Set(state.hits.map((h) => h.id));
  for (const id of named) if (!ids.has(id)) throw new Error(`no hit ${id}`);
  const ctx = context(deps, {}, run, state.round, "triage");
  const byKey = new Map(state.hits.map((h) => [h.key, h.id]));
  for (const url of input.urls ?? []) {
    const key = canonical(url);
    const have = byKey.get(key);
    if (have) {
      named.push(have);
      continue;
    }
    const id = await ctx.write({ type: "hit", url, key, queries: [], sources: [] }, who);
    byKey.set(key, id);
    named.push(id);
  }
  for (const id of new Set(named))
    await ctx.write({ type: "call", on: id, verdict: "keep", why: input.why as string }, who);
  const snapshot = state.snapshot;
  const joining = (input.with ?? []).filter((n) => !snapshot?.sources.includes(n));
  if (joining.length && snapshot) {
    for (const n of joining) {
      const s = deps.sources.get(n);
      if (!s) throw new Error(`no source named ${n}`);
      if (!s.open) throw new Error(`${n} opens nothing: only an open source joins a read`);
    }
    const { id: _id, at: _at, from: _from, by: _by, ...rest } = snapshot;
    await ctx.write({ ...rest, sources: [...snapshot.sources, ...joining] }, who);
  }
  return stepRun(deps, run, "read", (c, s) => readHits(c, s, unread(s)));
}

/** Documents of any round the extractor has no verdict on. */
export const unjudged = (state: RunState): DocumentRecord[] => {
  const judged = new Set(state.verdicts.map((v) => v.document));
  return state.documents.filter((d) => !judged.has(d.id));
};

/** The extract step over the documents named, else every one of the run without a verdict. */
export async function extract(
  deps: Deps,
  run: string,
  documents?: readonly string[],
): Promise<Did> {
  return stepRun(deps, run, "extract", (c, s) => {
    const docs = documents
      ? documents.map((id) => {
          const d = s.documents.find((x) => x.id === id);
          if (!d) throw new Error(`no document ${id}`);
          return d;
        })
      : unjudged(s);
    return extractDocuments(c, s, docs);
  });
}

/** Kept findings the run's patterns rest on that no check has read. */
export const uncheckedOf = (state: RunState, ids: readonly string[]): string[] => {
  const checked = new Set(state.checks.map((c) => c.on));
  const byId = new Map(state.findings.map((f) => [f.id, f]));
  return ids.filter((id) => {
    const f = byId.get(id);
    return !!f?.proof.quote && kept(state, f) && !checked.has(id);
  });
};

/** Findings the judge says credit another named source. */
export const citesOf = (state: RunState, ids: readonly string[]): string[] =>
  ids.filter((id) => (yesOf(state, id, "cites") ?? 0) > 0.5);

/**
 * The check over the findings named; else, with `patterns`, every unchecked finding a pattern
 * rests on; else a sample spread over documents: `n`, or the budget's `checks` or a tenth of
 * the kept findings, whichever is more.
 */
export async function check(
  deps: Deps,
  run: string,
  input: { findings?: readonly string[]; n?: number; patterns?: boolean } = {},
): Promise<Did> {
  return stepRun(deps, run, "check", (c, s) => {
    const byId = new Map(s.findings.map((f) => [f.id, f]));
    const named = (ids: readonly string[]) =>
      ids.map((id) => {
        const f = byId.get(id);
        if (!f) throw new Error(`no finding ${id}`);
        return f;
      });
    const reach = s.findings.filter((f) => f.proof.quote && kept(s, f)).length;
    const sample = input.findings
      ? named(input.findings)
      : input.patterns
        ? named(uncheckedOf(s, [...new Set(s.patterns.flatMap((p) => p.findings))]))
        : spreadSample(s, input.n ?? checkCount(reach, s.snapshot?.budget.checks ?? 3));
    return checkSample(c, s, sample);
  });
}

/** What the agent or the person adds by hand. */
export type Addition =
  | { type: "query"; terms: string; why: string; site?: string; facet?: string }
  | { type: "finding"; document: string; text: string; quote: string }
  | { type: "check"; on: string; ok: boolean; why: string }
  | { type: "call"; on: string; verdict: "keep" | "drop"; why: string }
  | { type: "edge"; next: Edge["next"]; to?: Edge["to"]; why: string }
  | { type: "steer"; text: string }
  | { type: "gap"; note: string; on?: string }
  | { type: "pattern"; text: string; findings: string[] }
  | { type: "draft"; for: string; items: DraftInput[] }
  | { type: "class"; on: string; class: SourceClass; why: string }
  | { type: "dead"; facet: string; why: string };

/** One item of a draft as the agent writes it: cites are finding or pattern ids. */
export interface DraftInput {
  title?: string | null;
  body?: string | null;
  cites?: string[] | null;
}

export interface Added {
  record: Shown;
  /** What the agent should know: an edge past the budget, a finding on a dropped document. */
  warnings: string[];
}

/**
 * One record in the agent's or the person's name. A query, finding or pattern lands in the
 * current round; a call, edge, steer or gap in the round it is about (the one just reviewed,
 * between rounds). A finding goes through falcon's gate: its quote must be on the document,
 * word for word, or the add fails with the gate's why. A pattern names kept findings; its
 * source count is counted here, never claimed. No `step`: a hand-written record has none.
 */
export async function add(deps: Deps, run: string, a: Addition, who: Who): Promise<Added> {
  const state = await stateOf(deps, run);
  const round =
    a.type === "query" ||
    a.type === "finding" ||
    a.type === "pattern" ||
    a.type === "check" ||
    a.type === "draft" ||
    a.type === "class" ||
    a.type === "dead"
      ? state.round
      : personRound(state);
  const warnings: string[] = [];
  const write = async <T extends Omit<LedgerRecord, keyof Envelope>>(record: T) => {
    const id = deps.ids();
    const full = LedgerRecord.parse({
      ...record,
      id,
      run,
      round,
      at: deps.clock().toISOString(),
      from: who.from,
      by: who.by,
    });
    await deps.ledger.append(full);
    return full;
  };
  const why = (text: string, what: string) => {
    if (!text.trim()) throw new Error(`${what}: why?`);
    return text;
  };
  switch (a.type) {
    case "query": {
      if (!state.snapshot) throw new Error(`run ${run}: no plan yet`);
      const terms = a.terms.replace(/\s+/g, " ").trim();
      if (!terms) throw new Error("a query needs terms");
      return {
        record: await write({
          type: "query",
          kind: state.snapshot.ask.kind,
          terms,
          why: why(a.why, `query "${terms}"`),
          ...(a.site ? { site: a.site } : {}),
          ...(a.facet ? { facet: a.facet } : {}),
        }),
        warnings,
      };
    }
    case "finding": {
      const doc = state.documents.find((d) => d.id === a.document);
      if (!doc) throw new Error(`no document ${a.document}`);
      const answer: ClaimAnswer = { findings: [{ text: a.text, quote: a.quote }] };
      const gate = gateFindings(answer, doc);
      const f = gate.findings[0];
      if (!f) {
        const why = gate.dropped[0]?.why ?? "empty";
        throw new Error(
          why === "quote_short"
            ? "finding dropped at the gate: quote_short, the quote needs 5 words: take the line with its label or the next line"
            : `finding dropped at the gate: ${why}`,
        );
      }
      return {
        record: await write({
          type: "finding",
          ...f,
          document: doc.id,
          ...(doc.date ? { date: doc.date } : {}),
        }),
        warnings,
      };
    }
    case "check": {
      const f = state.findings.find((x) => x.id === a.on);
      if (!f) throw new Error(`no finding ${a.on}`);
      const record = await write({ type: "check", on: a.on, ok: a.ok, why: why(a.why, "check") });
      if (!a.ok) await write({ type: "call", on: a.on, verdict: "drop", why: a.why });
      return { record, warnings };
    }
    case "call": {
      const hit = state.hits.find((h) => h.id === a.on);
      const finding = hit ? undefined : state.findings.find((f) => f.id === a.on);
      if (!hit && !finding) throw new Error(`no hit or finding ${a.on}`);
      return {
        record: await write({
          type: "call",
          on: a.on,
          verdict: a.verdict,
          why: why(a.why, "call"),
        }),
        warnings,
      };
    }
    case "edge": {
      if (a.next === "back" && !a.to) throw new Error("edge back: to which step?");
      const budget = state.snapshot?.budget;
      if (a.next === "again" && budget && round >= budget.rounds)
        warnings.push(
          `round ${round + 1} is past the budget of ${budget.rounds}: a guard rail, not a stop`,
        );
      return {
        record: await write({
          type: "edge",
          next: a.next,
          ...(a.to ? { to: a.to } : {}),
          why: why(a.why, "edge"),
        }),
        warnings,
      };
    }
    case "steer":
      if (who.from !== "human") throw new Error("a steer is the person's word: --human");
      if (!a.text.trim()) throw new Error("steer: say what");
      return { record: await write({ type: "steer", text: a.text }), warnings };
    case "gap":
      if (!a.note.trim()) throw new Error("gap: say what is missing");
      return {
        record: await write({ type: "gap", note: a.note, ...(a.on ? { on: a.on } : {}) }),
        warnings,
      };
    case "pattern": {
      const byId = new Map(state.findings.map((f) => [f.id, f]));
      const on = [...new Set(a.findings)].map((id) => {
        const f = byId.get(id);
        if (!f) throw new Error(`no finding ${id}`);
        if (!kept(state, f))
          throw new Error(`finding ${id} is dropped: a pattern rests on kept findings`);
        return f;
      });
      const pattern = patternOf(a.text, on);
      const classes = classesOf(state, pattern.findings);
      if (sourcesOf(classes) < 2) warnings.push("one source: a claim, not a pattern yet");
      const cites = citesOf(state, pattern.findings);
      if (echoOf(classes))
        warnings.push(
          `vendor echo: every classed source is a vendor; vendors cite each other${cites.length ? `; the judge says ${cites.join(" ")} credit another source: read that source` : ""}`,
        );
      const unchecked = uncheckedOf(state, pattern.findings);
      if (unchecked.length)
        warnings.push(`unchecked: ${unchecked.join(" ")}; run check --patterns`);
      return { record: await write({ type: "pattern", ...pattern }), warnings };
    }
    case "dead": {
      const facet = a.facet.trim();
      if (!facet) throw new Error("dead: which facet?");
      if (state.dead.some((d) => d.facet === facet))
        throw new Error(`facet "${facet}" is dead already`);
      return { record: await write({ type: "dead", facet, why: why(a.why, "dead") }), warnings };
    }
    case "class": {
      const target =
        state.documents.some((d) => d.id === a.on) || state.findings.some((f) => f.id === a.on);
      if (!target) throw new Error(`no document or finding ${a.on}`);
      return {
        record: await write({ type: "class", on: a.on, class: a.class, why: why(a.why, "class") }),
        warnings,
      };
    }
    case "draft": {
      if (!a.for.trim()) throw new Error("draft: say what it is for");
      // Falcon's gate numbers its claims: each kept finding is one, a pattern stands for its findings.
      const keptOnes = state.findings.filter((f) => kept(state, f));
      const claims: NumberedClaim[] = keptOnes.map((f, i) => ({
        n: i + 1,
        angle: 0,
        claim: f.text,
        quote: f.proof.quote ?? "",
        source_url: f.proof.url,
      }));
      const nOf = new Map(keptOnes.map((f, i) => [f.id, i + 1]));
      const onPattern = new Map(state.patterns.map((p) => [p.id, p.findings]));
      const ns = (id: string) => (onPattern.get(id) ?? [id]).map((f) => nOf.get(f) ?? 0);
      const spec = { key: "draft", ask: a.for };
      const items: DraftRecord["items"] = [];
      const dropped: DraftRecord["dropped"] = [];
      // One item at a time: the gate's cap is a model's, not the agent's.
      for (const item of a.items) {
        const cites = [...new Set(item.cites ?? [])];
        const out = gateDrafts(
          { items: [{ title: item.title ?? "", body: item.body ?? "", cites: cites.flatMap(ns) }] },
          spec,
          claims,
        );
        const ok = out.kept[0];
        if (ok) items.push({ title: ok.title, body: ok.body, cites });
        else for (const d of out.dropped) dropped.push(d);
      }
      for (const d of dropped) warnings.push(`item "${d.title}" dropped at the gate: ${d.why}`);
      if (!items.length)
        throw new Error(
          `draft: every item failed the gate (${dropped.map((d) => d.why).join(", ") || "no items"}): cite kept findings or patterns, and take each number from a cited quote`,
        );
      return { record: await write({ type: "draft", for: a.for, items, dropped }), warnings };
    }
  }
}

/** What the agent takes from the judge in bulk: classes over a bar, or calls on uncalled hits. */
export type Acceptance =
  | { take: "class"; min: number; why: string }
  | { take: "keep"; over: number; why: string }
  | { take: "drop"; under: number; why: string };

/**
 * The judge's guesses over a bar, written in the agent's name with its why and the judge's
 * number: a class on each document with none, or a keep or drop on each uncalled hit by how
 * likely it serves the ask. The agent sets the bar and owns the records; the judge decides none.
 */
export async function accept(
  deps: Deps,
  run: string,
  a: Acceptance,
  who: Who,
): Promise<{ wrote: Shown[]; skipped: number }> {
  const state = await stateOf(deps, run);
  if (!a.why.trim()) throw new Error(`accept ${a.take}: why?`);
  const bar = a.take === "class" ? a.min : a.take === "keep" ? a.over : a.under;
  if (!(bar >= 0 && bar <= 1))
    throw new Error(`accept ${a.take}: the bar is a probability, 0 to 1`);
  const wrote: Shown[] = [];
  let skipped = 0;
  if (a.take === "class") {
    for (const d of state.documents) {
      if (state.classOf.has(d.id)) continue;
      const g = pickOf(state, d.id, "class");
      if (!g) continue;
      if (g.p < a.min || !(SOURCE_CLASSES as readonly string[]).includes(g.pick)) {
        skipped++;
        continue;
      }
      const why = `${a.why} (judge: ${g.pick} ${g.p.toFixed(2)})`;
      wrote.push(
        (await add(deps, run, { type: "class", on: d.id, class: g.pick as SourceClass, why }, who))
          .record,
      );
    }
    return { wrote, skipped };
  }
  for (const h of state.hits) {
    if (state.called.has(h.id)) continue;
    const yes = yesOf(state, h.id, "serves");
    if (yes === undefined) continue;
    if (a.take === "keep" ? yes <= a.over : yes >= a.under) {
      skipped++;
      continue;
    }
    const why = `${a.why} (judge: serves ${yes.toFixed(2)})`;
    wrote.push(
      (await add(deps, run, { type: "call", on: h.id, verdict: a.take, why }, who)).record,
    );
  }
  return { wrote, skipped };
}

/** What `learn` changes on a plan file. Every field is optional; the version always moves. */
export interface PlanChanges {
  sources?: string[];
  budget?: Partial<PlanFile["budget"]>;
  age?: string;
  propose?: string;
  triage?: string;
  review?: string;
  tree?: TreeGuide;
  runs?: PlanFile["runs"];
}

/**
 * The next version of a plan file: the current one with the changes, version plus one. Pure:
 * the ledger writes it (`weaver learn`), at the end of a run the agent and the person agreed
 * was good. The sources stay an allow-list raven narrows, never widens; `learn` is how it widens.
 */
export function tunePlan(current: PlanFile, changes: PlanChanges): PlanFile {
  const next = PlanFile.parse({
    ...current,
    ...(changes.sources ? { sources: changes.sources } : {}),
    budget: { ...current.budget, ...(changes.budget ?? {}) },
    ...(changes.age !== undefined ? { age: changes.age } : {}),
    ...(changes.propose ? { propose: changes.propose } : {}),
    ...(changes.triage ? { triage: changes.triage } : {}),
    ...(changes.review ? { review: changes.review } : {}),
    ...(changes.tree ? { tree: changes.tree } : {}),
    ...(changes.runs ? { runs: changes.runs } : {}),
    version: current.version + 1,
  });
  if (JSON.stringify({ ...next, version: 0 }) === JSON.stringify({ ...current, version: 0 }))
    throw new Error("learn: nothing changed");
  return next;
}

/** A hit as the brief shows it: the view, its id, round and queries. */
export type HitBrief = Omit<HitRecord, "type" | "run" | "step" | "at" | "from" | "by" | "key"> & {
  /** The facets whose queries found it. */
  facets: string[];
  /**
   * The judge's hint: how likely it serves the ask, whose side wrote it, its class. The brief
   * lists hits by facets plus `serves`, most first. A hint: the agent calls each.
   */
  judge?: { serves: number; side: string; class: string };
};

export interface Brief {
  run: string;
  round: number;
  /** Where the runner would go next; null when an edge said stop. */
  next: Pointer | null;
  /** The last edge's why, or the step that gave up. */
  note: string | null;
  ask: NonNullable<RunState["snapshot"]>["ask"] | null;
  budget: NonNullable<RunState["snapshot"]>["budget"] | null;
  sources: string[];
  planFile: NonNullable<RunState["snapshot"]>["planFile"] | null;
  /** What the person said, oldest first. */
  steer: string[];
  /** What the last round left open: its edge's why, its gaps, the person's calls. */
  open: string[];
  /** This round's gaps, as lines. */
  gaps: string[];
  findings: {
    kept: {
      id: string;
      round: number;
      text: string;
      quote?: string;
      url: string;
      date?: string;
    }[];
    dropped: number;
  };
  checks: { on: string; ok: boolean; why: string }[];
  /** What the agent says several findings say together, its sources counted now over kept findings. */
  patterns: {
    id: string;
    round: number;
    text: string;
    findings: string[];
    /** Distinct sites over its kept findings; each forum thread counts on its own. */
    sources: number;
    /** Sources per class; `unclassed` counts the sites with none. */
    classes: Partial<Record<SourceClass | "unclassed", number>>;
    /** Every classed source is a vendor. */
    echo: boolean;
    /** Kept findings it rests on that no check has read. */
    unchecked: string[];
    /** Findings the judge says credit another source (a survey, a report): read that one. */
    cites: string[];
  }[];
  /** The run this one is a child of. */
  parent: { run: string; round: number; why: string } | null;
  /** The runs that name this one as parent, and what the tree under it read and cost. */
  children: ChildView[];
  treeCost: ReturnType<typeof costOf> | null;
  /** Facets given up on, with why. */
  dead: { facet: string; why: string }[];
  /** The latest rough draft, or null: never the final. */
  draft: { id: string; round: number; for: string; items: DraftRecord["items"] } | null;
  verdicts: { document: string; url: string; quality: string; gap?: string }[];
  /** This round's query tree with what each try wrote; null when the round's queries are flat. */
  tree: TreeView | null;
  hits: {
    uncalled: HitBrief[];
    toRead: { id: string; url: string }[];
    read: number;
    total: number;
  };
  documents: {
    toExtract: { id: string; url: string }[];
    /**
     * Documents with a kept finding and no class: class them before the patterns count. `guess`
     * is the judge's; `accept <run> class` takes every guess over a bar.
     */
    unclassed: { id: string; url: string; guess?: { class: string; p: number } }[];
    total: number;
  };
  edges: { round: number; next: string; to?: string; why: string; by: string }[];
  /** What the allow-list's sources yielded over every run. */
  yield: YieldRow[];
  /** What the judge did and how often the agent and the check agreed with it. */
  judge: JudgeStats;
  cost: ReturnType<typeof costOf>;
}

/** What raven's prompts see, as JSON: everything the agent needs to plan, triage, review and stop. */
export async function brief(deps: Deps, run: string): Promise<Brief> {
  const state = await stateOf(deps, run);
  const s = state.snapshot;
  const round = state.round;
  const urlOf = new Map(state.documents.map((d) => [d.id, d.url]));
  const sources = s?.sources ?? [];
  const yieldRows = (await deps.ledger.yield()).filter(
    (r) => r.source === undefined || sources.includes(r.source),
  );
  const gapLine = (g: RunState["gaps"][number]) => `${g.step ?? g.by}: ${g.note}`;
  const facetOf = new Map(state.queries.flatMap((q) => (q.facet ? [[q.id, q.facet]] : [])));
  const qOf = queriesOf(state);
  const facetsOf = (hit: string) =>
    [...new Set([...(qOf.get(hit) ?? [])].flatMap((q) => facetOf.get(q) ?? []))].sort();
  const family = await runTree(deps, run);
  const tree =
    s && state.queries.some((q) => q.round === round && q.facet)
      ? treeView(state, round, await guideOf(deps, s.ask))
      : null;
  return {
    run,
    round,
    next: state.next,
    note: state.note,
    ask: s?.ask ?? null,
    budget: s?.budget ?? null,
    sources,
    planFile: s?.planFile ?? null,
    steer: state.steers.map((x) => x.text),
    open: round > 1 ? openAfter(state, round - 1) : [],
    gaps: state.gaps.filter((g) => g.round === round).map(gapLine),
    findings: {
      kept: state.findings
        .filter((f) => kept(state, f))
        .map((f) => ({
          id: f.id,
          round: f.round,
          text: f.text,
          ...(f.proof.quote ? { quote: f.proof.quote } : {}),
          url: f.proof.url,
          ...(f.date ? { date: f.date } : {}),
        })),
      dropped: state.findings.filter((f) => !kept(state, f)).length,
    },
    checks: state.checks.map(({ on, ok, why }) => ({ on, ok, why })),
    patterns: state.patterns.map(({ id, round, text, findings }) => {
      const classes = classesOf(state, findings);
      return {
        id,
        round,
        text,
        findings,
        sources: sourcesOf(classes),
        classes,
        echo: echoOf(classes),
        unchecked: uncheckedOf(state, findings),
        cites: citesOf(state, findings),
      };
    }),
    parent: s?.parent ?? null,
    children: family.children,
    treeCost: family.children.length ? family.cost : null,
    dead: state.dead.map(({ facet, why }) => ({ facet, why })),
    draft: (() => {
      const d = state.drafts.at(-1);
      return d ? { id: d.id, round: d.round, for: d.for, items: d.items } : null;
    })(),
    verdicts: state.verdicts.map((v) => ({
      document: v.document,
      url: urlOf.get(v.document) ?? v.document,
      quality: v.quality,
      ...(v.gap ? { gap: v.gap } : {}),
    })),
    tree,
    hits: {
      uncalled: state.hits
        .filter((h) => !state.called.has(h.id))
        .map(({ type: _t, run: _r, step: _s, at: _a, from: _f, by: _b, key: _k, ...view }) => {
          const serves = yesOf(state, view.id, "serves");
          const side = pickOf(state, view.id, "side");
          const cls = pickOf(state, view.id, "class");
          return {
            ...view,
            facets: facetsOf(view.id),
            ...(serves !== undefined
              ? { judge: { serves, side: side?.pick ?? "", class: cls?.pick ?? "" } }
              : {}),
          };
        })
        .sort(
          (a, b) =>
            b.facets.length + (b.judge?.serves ?? 0) - (a.facets.length + (a.judge?.serves ?? 0)),
        ),
      toRead: unread(state).map(({ id, url }) => ({ id, url })),
      read: state.documents.length,
      total: state.hits.length,
    },
    documents: {
      toExtract: unjudged(state).map(({ id, url }) => ({ id, url })),
      unclassed: state.documents
        .filter(
          (d) =>
            !state.classOf.has(d.id) &&
            state.findings.some((f) => f.document === d.id && kept(state, f)),
        )
        .map(({ id, url }) => {
          const g = pickOf(state, id, "class");
          return { id, url, ...(g ? { guess: { class: g.pick, p: g.p } } : {}) };
        }),
      total: state.documents.length,
    },
    edges: state.edges.map(({ round, next, to, why, by }) => ({
      round,
      next,
      ...(to ? { to } : {}),
      why,
      by,
    })),
    yield: yieldRows,
    judge: judgeStats(state, deps.judge?.id ?? state.judges.at(-1)?.by ?? null),
    cost: costOf(state.spends),
  };
}
