/**
 * A judge answers typed questions about a state with probabilities and no text: yes or no, one
 * of named labels, a score on a rubric. Jev (TypeSafe's `/v1/systemone`) is the one in v1; Laya
 * serves the same shape (`TYPESAFE_BASE_URL`). Cheap enough to ask about every hit, page and
 * finding; never the final call: a caller ranks, hints or routes work to a model on its answers.
 *
 * Every answer comes back as each label's probability: a yes or no as `yes` and `no`, a score
 * as its levels ("0", "1", ...). Usage is priced from the one price table.
 */
import {
  APIError,
  type EntryType,
  type Fetch,
  type Questions,
  TypeSafeClient,
} from "@typesafe-ai/sdk";
import type { EnvMap } from "./keys.js";
import { priced } from "./prices.js";
import type { Usage } from "./types.js";

export { choice, type EntryType, noul, type Questions, score } from "@typesafe-ai/sdk";

/** Each label's probability, per question. */
export type Probs = Readonly<Record<string, number>>;

export interface Judged<K extends string = string> {
  /** The model that answered, as the vendor names it. */
  model: string;
  answers: Readonly<Record<K, Probs>>;
  usage: Usage;
  ms: number;
}

export interface Judge {
  /** The model id asked for: a spend's `source`, a record's `by`. */
  readonly id: string;
  judge<Q extends Questions>(
    state: EntryType,
    questions: Q,
    o?: { signal?: AbortSignal },
  ): Promise<Judged<keyof Q & string>>;
}

export const JEV_MODEL = "jev-1.13.0";
/** One try's wait; the SDK tries twice at most. */
const JEV_TRY_MS = 20_000;

/**
 * Why a judge call failed, which says what comes next. `refused`: the input (400, 413, 415,
 * 422), never asked again. `key`: the key or account (401, 402, 403), the pass stops. `down`:
 * anything else (429, 5xx, a timeout).
 */
export type JudgeFailure = "refused" | "key" | "down";
export function judgeFailure(err: unknown): JudgeFailure {
  const status = err instanceof APIError ? err.status : (err as { status?: unknown })?.status;
  if (typeof status !== "number") return "down";
  if ([400, 413, 415, 422].includes(status)) return "refused";
  if ([401, 402, 403].includes(status)) return "key";
  return "down";
}

/** The label with the most weight, and its probability. */
export function top(probs: Probs): [string, number] {
  let best: [string, number] = ["", 0];
  for (const [k, p] of Object.entries(probs)) if (p > best[1]) best = [k, p];
  return best;
}

/** An SDK answer as label probabilities. */
function probsOf(a: unknown): Probs {
  const x = a as { type?: string; noul?: number; probabilities?: Record<string, number> };
  if (x.type === "noul" && typeof x.noul === "number") return { yes: x.noul, no: 1 - x.noul };
  return { ...(x.probabilities ?? {}) };
}

/** Jev through TypeSafe's SDK; Laya with its `baseURL` and model. */
export function jevJudge(o: {
  apiKey: string;
  model?: string;
  baseURL?: string;
  tryMs?: number;
  fetch?: Fetch;
}): Judge {
  const id = o.model ?? JEV_MODEL;
  const client = new TypeSafeClient({
    apiKey: o.apiKey,
    ...(o.baseURL ? { baseURL: o.baseURL } : {}),
    defaultModel: id,
    timeout: o.tryMs ?? JEV_TRY_MS,
    retry: { maxRetries: 1 },
    logLevel: "off",
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
  return {
    id,
    async judge(state, questions, { signal } = {}) {
      const t0 = performance.now();
      const r = await client.systemOne({ state, questions }, signal ? { signal } : {});
      const answers = Object.fromEntries(
        Object.entries(r.answers as Record<string, unknown>).map(([k, a]) => [k, probsOf(a)]),
      );
      return {
        model: r.model,
        answers: answers as Judged<keyof typeof questions & string>["answers"],
        usage: priced(id, { input: r.usage.input_tokens, output: r.usage.output_tokens }),
        ms: Math.round(performance.now() - t0),
      };
    },
  };
}

/**
 * A judge for tests and dry runs: `respond` gives each question's probabilities; a question it
 * leaves out gets even odds over its labels.
 */
export function fakeJudge(
  respond: (state: EntryType, questions: Questions) => Record<string, Probs> = () => ({}),
  id = "fake-judge",
): Judge {
  return {
    id,
    async judge(state, questions) {
      const got = respond(state, questions);
      const answers: Record<string, Probs> = {};
      for (const [k, q] of Object.entries(questions)) {
        const labels =
          q.type === "noul"
            ? ["yes", "no"]
            : q.type === "choice"
              ? Object.keys(q.criteria)
              : q.criteria.map((_, i) => String(i));
        answers[k] = got[k] ?? Object.fromEntries(labels.map((l) => [l, 1 / labels.length]));
      }
      return {
        model: id,
        answers: answers as Judged<keyof typeof questions & string>["answers"],
        usage: { input: 0, output: 0, usd: 0 },
        ms: 0,
      };
    },
  };
}

/**
 * A judge from a setting string: `jev` | `jev:<model>` | `fake` | `off` (null). Jev's key is
 * `TYPESAFE_API_KEY`; `TYPESAFE_BASE_URL` points it at Laya.
 */
export function judgeFromSpec(spec: string, env: EnvMap): Judge | null {
  const at = spec.indexOf(":");
  const name = at < 0 ? spec : spec.slice(0, at);
  const model = at < 0 ? undefined : spec.slice(at + 1) || undefined;
  if (name === "off") return null;
  if (name === "fake") return fakeJudge();
  if (name !== "jev") throw new Error(`unknown judge '${spec}'; expected jev[:model], fake or off`);
  const apiKey = env.TYPESAFE_API_KEY?.trim().split(/\s/)[0];
  if (!apiKey) throw new Error("jev needs TYPESAFE_API_KEY");
  const baseURL = env.TYPESAFE_BASE_URL;
  return jevJudge({ apiKey, ...(model ? { model } : {}), ...(baseURL ? { baseURL } : {}) });
}
