/**
 * The ports the runner is given, as one plain `deps` object. A source is one file that answers
 * `search` (hits for a query) or `open` (a hit read whole) or both; the registry holds them by
 * name and the plan's allow-list picks per run. The model is raven's, the extractor falcon's,
 * the ledger weaver's. Nothing here reaches the network: the adapters in `src/sources` do.
 */
import type { Document, Extractor } from "@wrenautomation/falcon/document";
import type { Model } from "@wrenautomation/models";
import type { Judge } from "@wrenautomation/models/judge";
import type { Criterion, HitViewIn, PlanFile, Proposal } from "@wrenautomation/raven";
import type { Ids } from "../ledger/ids.js";
import type { Ledger } from "../ledger/ledger.js";
import type { CostKind, FollowAs, From, HitRecord, QueryRecord } from "../ledger/records.js";

export interface Source {
  name: string;
  kind: "search" | "open" | "both";
  cost: CostKind;
  /** Who the records it writes are from. A person pasting URLs is `human`; the default is `tool`. */
  from?: From;
  /** Who its records are by: the person behind a paste. The default is the source's name. */
  by?: string;
  /**
   * Whether its search keeps to that site (a query's `site`). A site-scoped query skips a
   * searcher that would answer from everywhere. Absent: it keeps to any site.
   */
  keeps?(site: string): boolean;
  /** Hits as the source shows them for free. Throw on failure: the runner writes the spend. */
  search?(query: QueryRecord): Promise<HitViewIn[]>;
  /** Whether it lists that page's own posts (`posts`) or pages like it (`similar`). */
  follows?(as: FollowAs, url: string): boolean;
  /** The follow's hits, newest or closest first, `n` at most. Throw on failure, like search. */
  follow?(as: FollowAs, url: string, n: number): Promise<HitViewIn[]>;
  /**
   * Whether this source opens that URL at all (a YouTube page, an http(s) page). The read step
   * asks before a call, so a source that was never going to open it writes no spend. Absent: it
   * opens everything.
   */
  opens?(url: string): boolean;
  /**
   * Opens only its own site's URLs, better than any general opener (a thread as data, not a
   * fetched wall): it gets its turn before the rest, whatever the allow-list's order.
   */
  first?: true;
  /**
   * The hit read whole. Throw with the reason when it was fetched and nothing usable came back
   * (a 403, a block, no reader for the media): the runner writes the spend `ok: false` with the
   * reason and the next opener gets its turn.
   */
  open?(hit: HitRecord): Promise<Document>;
}

export type Sources = Map<string, Source>;

export const registry = (...sources: Source[]): Sources => new Map(sources.map((s) => [s.name, s]));

/** The allow-list's sources, in its order. A name no source answers to fails the run at its start. */
export function pick(sources: Sources, names: readonly string[]): Source[] {
  const missing = names.filter((n) => !sources.has(n));
  if (missing.length) throw new Error(`no source named ${missing.join(", ")}`);
  return names.map((n) => sources.get(n) as Source);
}

export interface Deps {
  sources: Sources;
  ledger: Ledger;
  /** null: no model. The plan is the proposals given; every hit is read; nothing is extracted. */
  model: Model | null;
  /** The steps that decide what comes next (plan, triage, review) take it; absent: `model`. */
  decider?: Model | null;
  extractor: Extractor;
  /** Cheap typed answers on every hit, page and finding: a hint and a router. Absent or null: none. */
  judge?: Judge | null;
  clock: () => Date;
  ids: Ids;
  /** `by` on the records the runner itself writes. */
  runner: string;
  /** The pause between tries of a call that failed with a Transient; `setTimeout` by default. A test passes a stub. */
  sleep?: (ms: number) => Promise<void>;
}

export interface RunOptions {
  /** Absent on a resume: the first snapshot has it. */
  ask?: {
    text: string;
    kind: PlanFile["kind"];
    known?: string[];
    /** What the ask takes as given; a known line with no source joins them. */
    premises?: string[];
    /** The person's tests of a good source: the judge asks each on every hit and page. */
    criteria?: Criterion[];
    /** What the person says at the start; `steer` records add to it between rounds. */
    steer?: string[];
    site?: string;
  };
  /** The ledger's tuned plan file for the ask's kind; raven's default when absent. */
  planFile?: PlanFile;
  /** Queries from people or other models, merged with the model's in round 1. */
  proposals?: readonly Proposal[];
  /** Narrows the plan file's sources for this run. */
  sources?: readonly string[];
  /** A new run's parent, and why this child: `--parent`. */
  parent?: { run: string; why: string };
  /** An earlier run to continue. */
  resume?: string;
  /** A run id for a new run; `deps.ids()` when absent. */
  run?: string;
  /** Called after each step, for a progress line. */
  onStep?: (event: StepEvent) => void;
  /** Steps to run before returning, whatever the pointer says: 64 by default. A loop that advances a run a little per pass passes a few. */
  steps?: number;
  /** Stop after each round's review when it says `again`: the person steers, then resumes. */
  pause?: boolean;
}

export interface StepEvent {
  run: string;
  round: number;
  step: string;
  ok: boolean;
  note?: string;
  ms: number;
}

/**
 * The searchers a query goes to: all of them, or for a site-scoped query those that keep to it.
 * A follow goes to the sources that follow its URL that way.
 */
export const searchersFor = (
  sources: readonly Source[],
  q: Pick<QueryRecord, "site" | "follow">,
): Source[] => {
  const f = q.follow;
  if (f) return sources.filter((s) => s.follow && s.follows?.(f.as, f.url));
  const searchers = sources.filter((s) => s.search);
  return q.site ? searchers.filter((s) => s.keeps?.(q.site as string) ?? true) : searchers;
};

/** How many hits a follow lists. */
export const FOLLOW_N = 30;
