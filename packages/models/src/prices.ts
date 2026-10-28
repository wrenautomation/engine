/**
 * What a model call costs, in USD, from the tokens it reports: the one price table. Rates are
 * USD per million tokens (per hour for speech), by model id; a dated id
 * (`claude-haiku-5-5-20261001`) takes its base's row. A request is priced on its own prompt:
 * every input token, cache reads and writes included, picks the tier. A model with no row gets
 * no `usd`: the spend keeps the id and the tokens, so a price can be applied later. A free key
 * costs 0 and keeps the list price as `listUsd`.
 *
 * Sources, read 2026-10-27: Anthropic from the Claude API docs (cache writes 1.25x input for 5
 * minutes, 2x for 1 hour; reads 0.1x, Opus 5.5 0.05x); Cohere, Groq and Gemini from
 * third-party price lists that quote the vendor pages. Check a vendor page before a budget.
 */
import type { Usage } from "./types.js";

export const PRICES_AS_OF = "2026-10-27";

export interface Rate {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
}

export interface ModelPrice {
  /** The model id without a date suffix. */
  model: string;
  /** Said to a person. */
  name: string;
  vendor: string;
  /** Rates by prompt length, shortest first; `upTo` is the longest prompt a tier takes (null: any). */
  tiers: readonly { upTo: number | null; rate: Rate }[];
}

/** Anthropic's cache rates from its input and read rates. */
const claude = (input: number, output: number, cacheRead = input / 10): Rate => ({
  input,
  output,
  cacheRead,
  cacheWrite5m: input * 1.25,
  cacheWrite1h: input * 2,
});

export const MODEL_PRICES: readonly ModelPrice[] = [
  {
    model: "claude-opus-5-5",
    name: "Opus 5.5",
    vendor: "anthropic",
    tiers: [{ upTo: null, rate: claude(4, 20, 0.2) }],
  },
  {
    model: "claude-sonnet-5-5",
    name: "Sonnet 5.5",
    vendor: "anthropic",
    tiers: [{ upTo: null, rate: claude(2, 10) }],
  },
  {
    model: "claude-haiku-5-5",
    name: "Haiku 5.5",
    vendor: "anthropic",
    tiers: [
      { upTo: 100_000, rate: claude(0.1, 0.5) },
      { upTo: null, rate: claude(0.5, 2.5) },
    ],
  },
  {
    model: "claude-haiku-4-5",
    name: "Haiku 4.5",
    vendor: "anthropic",
    tiers: [{ upTo: null, rate: claude(1, 5) }],
  },
  {
    model: "command-a-03-2025",
    name: "Command A",
    vendor: "cohere",
    tiers: [{ upTo: null, rate: { input: 2.5, output: 10 } }],
  },
  {
    model: "openai/gpt-oss-120b",
    name: "gpt-oss-120b on Groq",
    vendor: "groq",
    tiers: [{ upTo: null, rate: { input: 0.15, output: 0.6, cacheRead: 0.075 } }],
  },
  {
    // Introductory to 2026-12-31; from 2027-01-01 $1.50 in, $7.50 out.
    model: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    vendor: "google",
    tiers: [{ upTo: null, rate: { input: 0.75, output: 3.75 } }],
  },
  {
    model: "gemini-3.5-flash",
    name: "Gemini 3.5 Flash",
    vendor: "google",
    tiers: [{ upTo: null, rate: { input: 1.5, output: 9 } }],
  },
  {
    model: "gemini-3.5-flash-lite",
    name: "Gemini 3.5 Flash-Lite",
    vendor: "google",
    tiers: [{ upTo: null, rate: { input: 0.3, output: 2.5 } }],
  },
  {
    // typesafe.ai pricing, read 2026-10-16: input only, answers free.
    model: "jev-1.13.0",
    name: "Jev 1.13",
    vendor: "typesafe",
    tiers: [{ upTo: null, rate: { input: 0.042, output: 0 } }],
  },
];

/** Speech to text, USD per hour of audio. */
export const SPEECH_PRICES: Readonly<Record<string, number>> = {
  "whisper-large-v3-turbo": 0.04,
  "whisper-large-v3": 0.111,
};

/** The model id with its vendor prefix (`groq:`, `anthropic/`) off, when the bare id has a row. */
const bare = (model: string): string => model.slice(model.indexOf(":") + 1);

/** The price row for a model id; a dated id takes its base's. */
export function priceOf(model: string): ModelPrice | null {
  const find = (id: string) =>
    MODEL_PRICES.find((p) => p.model === id) ??
    MODEL_PRICES.find(
      (p) => id.startsWith(`${p.model}-`) && /^\d+$/.test(id.slice(p.model.length + 1)),
    ) ??
    null;
  return find(model) ?? find(bare(model));
}

const n = (v: number | undefined) => (v && v > 0 ? v : 0);

/** The call's cost in USD, or undefined when the model has no row. Never throws. */
export function priceUsd(model: string, u: Usage): number | undefined {
  const p = priceOf(model);
  if (!p) return undefined;
  const input = n(u.input);
  const cacheRead = Math.min(n(u.cacheRead), input);
  const cacheWrite = Math.min(n(u.cacheWrite), input - cacheRead);
  const write1h = Math.min(n(u.cacheWrite1h), cacheWrite);
  const plain = input - cacheRead - cacheWrite;
  const tier = p.tiers.find((t) => t.upTo === null || input <= t.upTo) ?? p.tiers.at(-1);
  if (!tier) return undefined;
  const r = tier.rate;
  return (
    (plain * r.input +
      cacheRead * (r.cacheRead ?? r.input) +
      (cacheWrite - write1h) * (r.cacheWrite5m ?? r.input) +
      write1h * (r.cacheWrite1h ?? r.input) +
      n(u.output) * r.output) /
    1_000_000
  );
}

/** The usage with its price. A free call says `usd: 0`, `free: true` and its list price. */
export function priced(model: string, usage: Usage, o: { free?: boolean } = {}): Usage {
  const list = priceUsd(model, usage);
  if (o.free)
    return { ...usage, usd: 0, free: true, ...(list !== undefined ? { listUsd: list } : {}) };
  return list === undefined ? { ...usage } : { ...usage, usd: list };
}

/** What `seconds` of speech cost on a speech model, or undefined with no row. */
export function speechUsd(model: string, seconds: number): number | undefined {
  const perHour = SPEECH_PRICES[bare(model)] ?? SPEECH_PRICES[model];
  return perHour === undefined ? undefined : (perHour * seconds) / 3600;
}

/** Two usages added, each field summed where either side has it. */
export function addUsage(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
  if (!a) return b;
  if (!b) return a;
  const out: Usage = {};
  for (const k of [
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "cacheWrite1h",
    "usd",
    "listUsd",
  ] as const) {
    const x = a[k];
    const y = b[k];
    if (x !== undefined || y !== undefined) out[k] = (x ?? 0) + (y ?? 0);
  }
  if (a.free && b.free) out.free = true;
  return out;
}

const dollars = (v: number) => `$${v.toFixed(2)}`;

/** "Opus 5.5 $4.00 in, $20.00 out; ... per million tokens". */
export function pricesText(vendor?: string): string {
  return `${MODEL_PRICES.filter((m) => !vendor || m.vendor === vendor)
    .flatMap((m) => {
      const r = m.tiers[0]?.rate;
      return r ? [`${m.name} ${dollars(r.input)} in, ${dollars(r.output)} out`] : [];
    })
    .join("; ")}, per million tokens`;
}
