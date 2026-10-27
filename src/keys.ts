/** API keys from the environment and one rotation over them. */
import { isRefused, isTransient } from "./errors.js";
import { modelOf } from "./model.js";
import type { Model } from "./types.js";

export type EnvMap = Readonly<Record<string, string | undefined>>;

/**
 * A vendor's keys, model-keys-file style: `NUM_<V>` plus `<V>_API_KEY_1..N` (gaps passed over),
 * else one `<V>_API_KEY`. A line may carry an inline note after the key.
 */
export function fleetKeys(env: EnvMap, vendor: string): string[] {
  const upper = vendor.toUpperCase();
  const first = (v: string | undefined) => v?.trim().split(/\s/)[0] || undefined;
  const count = Number.parseInt(env[`NUM_${upper}`] ?? "0", 10);
  const keys: string[] = [];
  for (let n = 1; n <= count; n++) {
    const key = first(env[`${upper}_API_KEY_${n}`]);
    if (key) keys.push(key);
  }
  const single = first(env[`${upper}_API_KEY`]);
  if (!keys.length && single) keys.push(single);
  return keys;
}

export interface RotateOptions {
  /**
   * Passes over the whole ring while keys only say "later" (429, 5xx). Default 1: the caller
   * owns waiting. More passes wait between them, doubling from `waitMs` up to `maxWaitMs`.
   */
  passes?: number;
  waitMs?: number;
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const nap = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Call over a ring of keys, round robin from `start()`. A refused key (401, 402, 403) hands the
 * call to the next at once; a busy one (429, 5xx, a dropped connection) does too, and when the
 * whole ring is busy the pass ends. Any other error is the call's and is thrown as is.
 */
export async function overRing<K, T>(
  ring: readonly K[],
  call: (k: K) => Promise<T>,
  start: () => number,
  o: RotateOptions = {},
): Promise<T> {
  const { passes = 1, waitMs = 2000, maxWaitMs = 30_000, sleep = nap } = o;
  let last: unknown;
  for (let pass = 0; pass < passes; pass++) {
    if (pass > 0) await sleep(Math.min(waitMs * 2 ** (pass - 1), maxWaitMs));
    let busy = false;
    for (let tried = 0; tried < ring.length; tried++) {
      try {
        return await call(ring[start() % ring.length] as K);
      } catch (err) {
        if (!isRefused(err) && !isTransient(err)) throw err;
        if (isTransient(err)) busy = true;
        last = err;
      }
    }
    if (!busy) break;
  }
  throw last;
}

/** A round-robin cursor: each call returns the next index. */
export const cursor = () => {
  let n = 0;
  return () => n++;
};

/** One model over several keys (one model per key), by `overRing`. */
export function rotating(models: readonly Model[], o: RotateOptions = {}): Model {
  const first = models[0];
  if (!first) throw new Error("rotating needs at least one model");
  if (models.length === 1 && (o.passes ?? 1) <= 1) return first;
  const next = cursor();
  return modelOf({
    id: first.id,
    provider: first.provider,
    takes: first.takes,
    complete: (req) => overRing(models, (m) => m.complete(req), next, o),
  });
}
