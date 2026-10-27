/**
 * The interpreter: fold the trace, take the pointer's step from the table, write `done`, fold
 * again. `--resume` is the same loop on an old run: the fold says where it stopped. Every model
 * ask and source call writes a `spend` with what it cost and whether it worked. A call that
 * fails with a `Transient` is tried again with a pause, three tries in all, every attempt on
 * record; a step that still cannot go on throws it past the runner with no `done`, so a resume
 * runs the step again once the cause has passed. A model answer the output cap cut (falcon's
 * `Cut`) is a spend that worked, with its tokens: the extractor goes on from it. `pause` stops
 * the loop after a review that says `again`, so the person can steer before the next round.
 */
import { isCut } from "@wrenautomation/falcon/document";
import type { Model, Usage } from "@wrenautomation/raven";
import { type Envelope, type From, LedgerRecord, type Step } from "../ledger/records.js";
import type { Deps, RunOptions, Source } from "./ports.js";
import { fold, type RunState } from "./state.js";
import { STEP_TABLE, type StepContext } from "./steps.js";
import { Transient } from "./transient.js";

export interface RunResult {
  run: string;
  rounds: number;
  /** Why the run stopped: the last edge's why, or the step that gave up. */
  note: string | null;
  /** The run stopped on an edge, not on a step that gave up. */
  finished: boolean;
  /** The run stopped after a review that said `again`, on `pause`: `resume` goes on. */
  paused: boolean;
  state: RunState;
}

/** Tries per call over a Transient. */
export const TRIES = 3;
/** The longest pause before another try, whatever `retry-after` said. */
const MAX_WAIT_MS = 60_000;
/** The default step bound: three full rounds and some backs. */
export const DEFAULT_STEPS = 64;

/** The pause before the next try: to `retryAfter` (a minute at most), else a second per try so far. */
export function waitMs(attempt: number, retryAfter: string | undefined, now: () => Date): number {
  if (retryAfter) {
    const until = Date.parse(retryAfter) - now().getTime();
    if (!Number.isNaN(until)) return Math.max(0, Math.min(until, MAX_WAIT_MS));
  }
  return 1000 * attempt;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function run(deps: Deps, options: RunOptions = {}): Promise<RunResult> {
  const id = options.resume ?? options.run ?? deps.ids();
  if (!options.resume && !options.ask) throw new Error("a new run needs an ask");
  const steps = options.steps ?? DEFAULT_STEPS;
  let state = fold(id, await deps.ledger.trace(id));
  if (options.resume && !state.records.length) throw new Error(`run ${id}: no records`);
  let paused = false;
  for (let n = 0; n < steps && state.next; n++) {
    const { round, step } = state.next;
    const ctx = context(deps, options, id, round, step);
    const t0 = performance.now();
    let result: Awaited<ReturnType<(typeof STEP_TABLE)[Step]>>;
    try {
      result = await STEP_TABLE[step](ctx, state);
    } catch (err) {
      if (err instanceof Transient) throw err;
      result = { ok: false, note: message(err) };
    }
    await ctx.write(
      { type: "done", step, ok: result.ok, ...(result.note ? { note: result.note } : {}) },
      { from: "tool", by: deps.runner },
    );
    const ms = Math.round(performance.now() - t0);
    options.onStep?.({
      run: id,
      round,
      step,
      ok: result.ok,
      ...(result.note ? { note: result.note } : {}),
      ms,
    });
    state = fold(id, await deps.ledger.trace(id));
    if (!result.ok) break;
    if (options.pause && step === "review" && state.next?.step === "plan") {
      paused = true;
      break;
    }
  }
  return {
    run: id,
    rounds: state.round,
    note: state.note,
    finished: !state.next && state.edges.at(-1)?.next === "stop",
    paused,
    state,
  };
}

type Outcome =
  | { ok: true; usd?: number; tokens?: { input?: number; output?: number } }
  | { ok: false; error: string; retryAfter?: string };

const tokens = (u: Usage | undefined): Omit<Extract<Outcome, { ok: true }>, "ok"> => ({
  ...(u?.usd !== undefined ? { usd: u.usd } : {}),
  ...(u && (u.input !== undefined || u.output !== undefined)
    ? {
        tokens: {
          ...(u.input !== undefined ? { input: u.input } : {}),
          ...(u.output !== undefined ? { output: u.output } : {}),
        },
      }
    : {}),
});

function context(
  deps: Deps,
  options: RunOptions,
  run: string,
  round: number,
  step: Step,
): StepContext {
  const sleep = deps.sleep ?? defaultSleep;
  const write: StepContext["write"] = async (record, who) => {
    const id = deps.ids();
    const full = LedgerRecord.parse({
      ...record,
      id,
      run,
      round,
      step,
      at: deps.clock().toISOString(),
      from: who.from,
      by: who.by,
    });
    await deps.ledger.append(full);
    return id;
  };
  type Spender = Source | { name: string; cost: "metered" };
  const spend = (
    source: Spender,
    op: "search" | "open" | "ask",
    about: string,
    on: string | undefined,
    t0: number,
    outcome: Outcome,
  ) =>
    write(
      {
        type: "spend",
        source: source.name,
        op,
        about: about.slice(0, 200),
        ...(on ? { on } : {}),
        cost: source.cost,
        ms: Math.round(performance.now() - t0),
        ...outcome,
      },
      { from: "tool", by: deps.runner },
    );
  /** One attempt, its spend written either way. */
  const once = async <T>(
    source: Spender,
    op: "search" | "open" | "ask",
    about: string,
    on: string | undefined,
    call: () => Promise<T>,
    usageOf?: (out: T) => Usage | undefined,
  ): Promise<T> => {
    const t0 = performance.now();
    try {
      const out = await call();
      await spend(source, op, about, on, t0, { ok: true, ...tokens(usageOf?.(out)) });
      return out;
    } catch (err) {
      if (isCut(err)) await spend(source, op, about, on, t0, { ok: true, ...tokens(err.usage) });
      else
        await spend(source, op, about, on, t0, {
          ok: false,
          error: message(err),
          ...(err instanceof Transient && err.retryAfter ? { retryAfter: err.retryAfter } : {}),
        });
      throw err;
    }
  };
  /** The call again after a Transient, with a pause, TRIES in all. */
  const tried = async <T>(call: () => Promise<T>): Promise<T> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await call();
      } catch (err) {
        if (!(err instanceof Transient) || attempt >= TRIES) throw err;
        await sleep(waitMs(attempt, err.retryAfter, deps.clock));
      }
    }
  };
  const invoke: StepContext["invoke"] = async (source, op, about, on, call) => {
    try {
      return await tried(() => once(source, op, about, on, call));
    } catch (err) {
      if (err instanceof Transient) throw err;
      return null;
    }
  };
  const modelOn = (on?: string): Model | null =>
    deps.model
      ? {
          id: deps.model.id,
          ask: (prompt, shape) => {
            const m = deps.model as Model;
            const about = prompt.split("\n").find((l) => l.trim()) ?? "";
            return tried(() =>
              once(
                { name: m.id, cost: "metered" },
                "ask",
                about,
                on,
                () => m.ask(prompt, shape),
                (a) => a.usage,
              ),
            );
          },
        }
      : null;
  return { deps, options, model: modelOn(), modelOn, run, round, step, write, invoke };
}

export type { Envelope, From };
