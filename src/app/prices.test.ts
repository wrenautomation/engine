import { describe, expect, it } from "vitest";
import { costOf } from "./engine-cli.js";
import { priced, priceUsd } from "./prices.js";

describe("priceUsd", () => {
  it("prices Haiku on the small card, and on the large card over 100k prompt tokens", () => {
    expect(priceUsd("claude-haiku-5-5", { input: 1_000_000, output: 1_000_000 })).toBeCloseTo(3, 9);
    expect(priceUsd("claude-haiku-5-5", { input: 10_000, output: 1000 })).toBeCloseTo(0.0015, 9);
    expect(priceUsd("claude-haiku-5-5", { input: 200_000, output: 1000 })).toBeCloseTo(0.1025, 9);
  });
  it("prices Sonnet and Opus, and leaves an unknown model unpriced", () => {
    expect(priceUsd("claude-sonnet-5-5", { input: 1_000_000, output: 100_000 })).toBeCloseTo(3, 9);
    expect(priceUsd("claude-opus-5-5", { input: 500_000, output: 50_000 })).toBeCloseTo(3, 9);
    expect(priceUsd("claude-opus-4-1", { input: 1, output: 1 })).toBeUndefined();
    expect(priced("claude-opus-4-1", { input: 1, output: 1 })).toEqual({ input: 1, output: 1 });
  });
});

describe("costOf", () => {
  const base = {
    type: "spend" as const,
    id: "s",
    run: "r",
    round: 1,
    step: "extract" as const,
    at: "2026-10-27T00:00:00.000Z",
    from: "tool" as const,
    by: "runner",
    op: "ask" as const,
    about: "x",
    ms: 1,
    ok: true as const,
  };
  it("adds USD where priced, counts metered calls without a price, totals tokens per source", () => {
    const c = costOf([
      {
        ...base,
        source: "claude-haiku-5-5",
        cost: "metered",
        usd: 0.01,
        tokens: { input: 100, output: 10 },
      },
      {
        ...base,
        source: "claude-haiku-5-5",
        cost: "metered",
        usd: 0.02,
        tokens: { input: 200, output: 20 },
      },
      { ...base, source: "exa", op: "search", cost: "metered" },
      { ...base, source: "searxng", op: "search", cost: "free" },
    ]);
    expect(c.total).toEqual({ usd: 0.03, unpriced: 1, input: 300, output: 30, calls: 4 });
    expect(c.line).toBe(
      "$0.0300 plus 1 metered calls with no price; claude-haiku-5-5 2 calls, 300 in, 30 out, $0.0300; exa 1 calls; searxng 1 calls",
    );
  });
});
