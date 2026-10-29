/**
 * The run tree: a child run names its parent on every snapshot. A wide run finds the niches;
 * a child per niche goes deep; a stopped child's patterns and dead ends reach the parent's next
 * plan. Each child keeps its own budget, stop and resume. A child's budget is never more than
 * its parent's. The depth and the children per round are guard rails: past the depth a warning.
 * The one hard stop is the pages the whole tree reads, pinned on the root's snapshot: depth costs
 * nothing a sibling would not, so only the total is worth a wall.
 */

import type { SnapshotRecord, SpendRecord } from "../ledger/records.js";
import type { Budget, PlanFile } from "../plan/index.js";
import { costOf } from "./cost.js";
import type { Deps } from "./ports.js";
import { recall } from "./recall.js";
import { classesOf, fold, type RunState } from "./state.js";

/** The caps when the plan file names none: the root and its children; six children per round. */
export const RUNS = { depth: 2, children: 6 };

export type Parent = NonNullable<SnapshotRecord["parent"]>;

type Reads = Pick<Deps, "ledger">;

const stateOf = async (deps: Reads, run: string): Promise<RunState> =>
  fold(run, await deps.ledger.trace(run));

/** The runs that name this one as parent, each by its first snapshot, in the order they began. */
export async function childrenOf(deps: Reads, run: string): Promise<SnapshotRecord[]> {
  const out = new Map<string, SnapshotRecord>();
  for (const r of await deps.ledger.scan({ type: ["snapshot"] }))
    if (r.type === "snapshot" && r.parent?.run === run && !out.has(r.run)) out.set(r.run, r);
  return [...out.values()];
}

/** The pages a tree may read, for a root's snapshot: the plan file's, else from the root's budget. */
export const treeReadsOf = (planFile: PlanFile, budget: Budget): number =>
  planFile.runs?.reads ??
  budget.reads * budget.rounds * ((planFile.runs?.children ?? RUNS.children) + 1);

/** The run's ancestors, root first, each by its latest snapshot. */
export async function lineageOf(deps: Reads, run: string): Promise<SnapshotRecord[]> {
  const out: SnapshotRecord[] = [];
  for (let s = (await stateOf(deps, run)).snapshot; s?.parent; ) {
    s = (await stateOf(deps, s.parent.run)).snapshot;
    if (s) out.unshift(s);
  }
  return out;
}

/** What the tree the run sits in may still read; null for a tree with no cap (a run before 0.21). */
export async function treeRoom(
  deps: Reads,
  run: string,
): Promise<{ root: string; cap: number; read: number; left: number } | null> {
  const root = (await lineageOf(deps, run))[0] ?? (await stateOf(deps, run)).snapshot;
  if (!root?.treeReads) return null;
  const read = (await runTree(deps, root.run)).reads;
  return { root: root.run, cap: root.treeReads, read, left: Math.max(0, root.treeReads - read) };
}

/** Per field, the smaller: a child never gets more than its parent. */
export const minBudget = (a: Budget, b: Budget): Budget => ({
  queries: Math.min(a.queries, b.queries),
  reads: Math.min(a.reads, b.reads),
  rounds: Math.min(a.rounds, b.rounds),
  checks: Math.min(a.checks, b.checks),
});

/** The plan file's budget, capped by the parent's on each round of a child. */
export async function budgetUnder(
  deps: Reads,
  parent: Parent | undefined,
  budget: Budget,
): Promise<Budget> {
  const up = parent && (await stateOf(deps, parent.run)).snapshot;
  return up ? minBudget(budget, up.budget) : budget;
}

/**
 * A new child's link, checked: the parent has a plan, its round has room for one more child, and
 * the tree has pages left to read. Past the depth, a warning: the why says why deeper beats a
 * sibling.
 */
export async function linkTo(
  deps: Reads,
  to: { run: string; why: string },
  planFile: PlanFile,
): Promise<{ parent: Parent; warnings: string[] }> {
  if (!to.why.trim()) throw new Error("--parent: why this child?");
  const up = (await stateOf(deps, to.run)).snapshot;
  if (!up) throw new Error(`parent ${to.run}: no plan yet`);
  const caps = { ...RUNS, ...planFile.runs };
  const level = (await lineageOf(deps, to.run)).length + 2;
  const room = await treeRoom(deps, to.run);
  if (room && !room.left)
    throw new Error(
      `--parent: the tree under ${room.root} read ${room.read} pages, its cap ${room.cap} (plan file runs.reads on the root)`,
    );
  const siblings = (await childrenOf(deps, to.run)).filter(
    (c) => c.parent?.round === up.round,
  ).length;
  if (siblings >= caps.children)
    throw new Error(
      `--parent: round ${up.round} of ${to.run} has ${siblings} children, the cap (plan file runs.children)`,
    );
  const warnings: string[] = [];
  if (level > caps.depth)
    warnings.push(
      `level ${level}, past runs.depth ${caps.depth}: a guard rail; the why says why a deeper run beats a sibling`,
    );
  const reads = (await runTree(deps, to.run)).reads;
  const cap = up.budget.reads * up.budget.rounds;
  if (reads >= cap)
    warnings.push(
      `the tree under ${to.run} read ${reads} pages, past its budget of ${cap}: a guard rail, not a stop`,
    );
  return {
    parent: { run: to.run, round: up.round, why: to.why },
    warnings,
  };
}

/**
 * What a parent's next plan reads from its children. A stopped child gives known lines: its
 * stop, its patterns with their sites per class, its dead ends (facets to skip). A child still
 * going is open. The lines name the child run and the pattern: the ledger is their source.
 */
export async function fromChildren(
  deps: Reads,
  run: string,
): Promise<{ known: string[]; open: string[] }> {
  const known: string[] = [];
  const open: string[] = [];
  for (const c of await childrenOf(deps, run)) {
    const s = await stateOf(deps, c.run);
    const ask = `"${c.ask.text}"`;
    if (s.next) {
      open.push(`child run ${c.run} (${ask}) has not stopped`);
      continue;
    }
    const stop = s.edges.filter((e) => e.next === "stop").at(-1);
    known.push(`child run ${c.run} (${ask}) stopped${stop ? `: ${stop.why}` : ""}`);
    for (const p of s.patterns) {
      const classes = Object.entries(classesOf(s, p.findings))
        .map(([k, n]) => `${k} ${n}`)
        .join(", ");
      known.push(`${p.text} (run ${c.run}, pattern ${p.id}; sources: ${classes || "none kept"})`);
    }
    for (const d of s.dead) known.push(`dead end, skip it: ${d.facet}: ${d.why} (run ${c.run})`);
  }
  return { known, open };
}

/** For a new child: what its parent and siblings already found that bears on its ask, with URLs. */
export async function fromSiblings(deps: Reads, parent: string, ask: string, n = 10) {
  const runs = [parent, ...(await childrenOf(deps, parent)).map((c) => c.run)];
  return (await recall(deps.ledger, ask, { runs, n })).map((r) => `${r.text} (${r.url})`);
}

export interface ChildView {
  run: string;
  ask: string;
  why: string;
  /** The parent's round it began in. */
  round: number;
  stopped: boolean;
  patterns: number;
  reads: number;
}

/** The run's children, and what the whole tree under it read and cost. */
export async function runTree(
  deps: Reads,
  run: string,
): Promise<{ children: ChildView[]; reads: number; cost: ReturnType<typeof costOf> }> {
  const spends: SpendRecord[] = [];
  let reads = 0;
  const children: ChildView[] = [];
  const walk = async (id: string, top: boolean) => {
    const s = await stateOf(deps, id);
    spends.push(...s.spends);
    reads += s.documents.length;
    for (const c of await childrenOf(deps, id)) {
      if (top) {
        const cs = await stateOf(deps, c.run);
        children.push({
          run: c.run,
          ask: c.ask.text,
          why: c.parent?.why ?? "",
          round: c.parent?.round ?? 1,
          stopped: !cs.next,
          patterns: cs.patterns.length,
          reads: cs.documents.length,
        });
      }
      await walk(c.run, false);
    }
  };
  await walk(run, true);
  return { children, reads, cost: costOf(spends) };
}
