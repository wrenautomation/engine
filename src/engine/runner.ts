/**
 * The interpreter: fold the trace, take the pointer's step from the table, write `done`, fold
 * again. `--resume` is the same loop on an old run: the fold says where it stopped. Every model
 * ask and source call writes a `spend` with what it cost and whether it worked.
 */
import type { Model } from "@wrenautomation/raven";
import { type Envelope, type From, LedgerRecord, type Step } from "../ledger/records.js";
import type { Deps, RunOptions, Source } from "./ports.js";
import { fold, type RunState } from "./state.js";
import { STEP_TABLE, type StepContext } from "./steps.js";

export interface RunResult {
  run: string;
  rounds: number;
  /** Why the run stopped: the last edge's why, or the step that gave up. */
  note: string | null;
  /** The run stopped on an edge, not on a step that gave up. */
  finished: boolean;
  state: RunState;
}

export async function run(deps: Deps, options: RunOptions = {}): Promise<RunResult> {
  const id = options.resume ?? options.run ?? deps.ids();
  if (!options.resume && !options.ask) throw new Error("a new run needs an ask");
  const steps = 64;
  let state = fold(id, await deps.ledger.trace(id));
  if (options.resume && !state.records.length) throw new Error(`run ${id}: no records`);
  for (let n = 0; n < steps && state.next; n++) {
    const { round, step } = state.next;
    const ctx = context(deps, options, id, round, step);
    const t0 = performance.now();
    let result: Awaited<ReturnType<(typeof STEP_TABLE)[Step]>>;
    try {
      result = await STEP_TABLE[step](ctx, state);
    } catch (err) {
      result = { ok: false, note: err instanceof Error ? err.message : String(err) };
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
  }
  return {
    run: id,
    rounds: state.round,
    note: state.note,
    finished: !state.next && state.edges.at(-1)?.next === "stop",
    state,
  };
}

function context(
  deps: Deps,
  options: RunOptions,
  run: string,
  round: number,
  step: Step,
): StepContext {
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
  const spend = async (
    source: Source | { name: string; cost: "metered" },
    op: "search" | "open" | "ask",
    about: string,
    on: string | undefined,
    t0: number,
    outcome:
      | { ok: true; usd?: number; tokens?: { input?: number; output?: number } }
      | { ok: false; error: string },
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
  const invoke: StepContext["invoke"] = async (source, op, about, on, call) => {
    const t0 = performance.now();
    try {
      const out = await call();
      await spend(source, op, about, on, t0, { ok: true });
      return out;
    } catch (err) {
      await spend(source, op, about, on, t0, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  };
  const modelOn = (on?: string): Model | null =>
    deps.model
      ? {
          id: deps.model.id,
          ask: async (prompt, shape) => {
            const m = deps.model as Model;
            const t0 = performance.now();
            const about = prompt.split("\n").find((l) => l.trim()) ?? "";
            try {
              const a = await m.ask(prompt, shape);
              const u = a.usage;
              await spend({ name: m.id, cost: "metered" }, "ask", about, on, t0, {
                ok: true,
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
              return a;
            } catch (err) {
              await spend({ name: m.id, cost: "metered" }, "ask", about, on, t0, {
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              });
              throw err;
            }
          },
        }
      : null;
  return { deps, options, model: modelOn(), modelOn, run, round, step, write, invoke };
}

export type { Envelope, From };
