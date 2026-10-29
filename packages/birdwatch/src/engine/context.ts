/**
 * The step context each agent command builds: `write` fills a record's envelope, `invoke` and the
 * model write a `spend` per call with what it cost and whether it worked. A call that fails with
 * a `Transient` is tried again with a pause, three tries in all, every attempt on record. A model
 * answer the output cap cut (models' `Cut`) is a spend that worked, with its tokens.
 */
import { isCut, isTransient, type Model, modelOf, promptText, type Usage } from "@wrenautomation/models";
import { judgeFailure } from "@wrenautomation/models/judge";
import { LedgerRecord, type Step } from "../ledger/records.js";
import type { Deps, Source } from "./ports.js";
import type { StepContext } from "./steps.js";

/** Tries per call over a Transient. */
export const TRIES = 3;
/** The longest pause before another try, whatever `retry-after` said. */
const MAX_WAIT_MS = 60_000;
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

/** The step context: `write` fills the envelope, `invoke` and `modelOn` write every spend. */
export function context(
  deps: Deps,
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
      { from: "tool", by: deps.writer },
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
          ...(isTransient(err) && err.retryAfter ? { retryAfter: err.retryAfter } : {}),
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
        if (!isTransient(err) || attempt >= TRIES) throw err;
        await sleep(waitMs(attempt, err.retryAfter, deps.clock));
      }
    }
  };
  const invoke: StepContext["invoke"] = async (source, op, about, on, call) => {
    try {
      return await tried(() => once(source, op, about, on, call));
    } catch (err) {
      if (isTransient(err)) throw err;
      return null;
    }
  };
  // Every call writes a spend, a repair's too: the wrap is on `complete`, and `ask` is built over it.
  const modelOn = (on?: string): Model | null => {
    const m = deps.model;
    if (!m) return null;
    return modelOf({
      id: m.id,
      provider: m.provider,
      takes: m.takes,
      complete: (req) => {
        const text = promptText(req.prompt) ?? "";
        const about = text.split("\n").find((l) => l.trim()) ?? "";
        return tried(() =>
          once(
            { name: m.id, cost: "metered" },
            "ask",
            about,
            on,
            () => m.complete(req),
            (r) => r.usage,
          ),
        );
      },
    });
  };
  const judge: StepContext["judge"] = async (on, about, state, questions) => {
    const j = deps.judge;
    if (!j) return { failure: "off" };
    const t0 = performance.now();
    const spender = { name: j.id, cost: "metered" as const };
    try {
      const r = await j.judge(state, questions);
      await spend(spender, "ask", about, on, t0, { ok: true, ...tokens(r.usage) });
      return r;
    } catch (err) {
      await spend(spender, "ask", about, on, t0, { ok: false, error: message(err) });
      return { failure: judgeFailure(err) };
    }
  };
  return { deps, model: modelOn(), modelOn, run, round, step, write, invoke, judge };
}
