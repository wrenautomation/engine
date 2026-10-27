import { describe, expect, it } from "vitest";
import { addUsage, priced, priceOf, pricesText, priceUsd, speechUsd } from "./prices.js";

describe("priceOf", () => {
  it("matches exactly before a dated suffix", () => {
    expect(priceOf("gemini-3.5-flash-lite")?.name).toBe("Gemini 3.5 Flash-Lite");
    expect(priceOf("gemini-3.5-flash")?.name).toBe("Gemini 3.5 Flash");
    expect(priceOf("claude-haiku-5-5-20261001")?.name).toBe("Haiku 5.5");
  });
  it("takes a vendor prefix off", () => {
    expect(priceOf("groq:openai/gpt-oss-120b")?.vendor).toBe("groq");
  });
  it("has no row for an unknown model", () => {
    expect(priceOf("mystery-1")).toBeNull();
    expect(priceUsd("mystery-1", { input: 10 })).toBeUndefined();
  });
});

describe("priceUsd", () => {
  it("prices cache reads and writes apart from plain input", () => {
    // Sonnet 5.5: $2 in, $10 out, read $0.20, write 5m $2.50.
    const usd = priceUsd("claude-sonnet-5-5", {
      input: 1_000_000,
      cacheRead: 500_000,
      cacheWrite: 200_000,
      output: 100_000,
    });
    expect(usd).toBeCloseTo(0.3 * 2 + 0.5 * 0.2 + 0.2 * 2.5 + 0.1 * 10, 6);
  });
  it("prices the 1-hour share of cache writes at 2x", () => {
    const usd = priceUsd("claude-sonnet-5-5", { input: 100, cacheWrite: 100, cacheWrite1h: 100 });
    expect(usd).toBeCloseTo((100 * 4) / 1e6, 9);
  });
  it("picks the Haiku 5.5 tier by the whole prompt, cache included", () => {
    expect(priceUsd("claude-haiku-5-5", { input: 100_000 })).toBeCloseTo(0.01, 9);
    expect(priceUsd("claude-haiku-5-5", { input: 100_001 })).toBeCloseTo(100_001 * 0.5e-6, 9);
    expect(priceUsd("claude-haiku-5-5", { input: 100_001, cacheRead: 100_000 })).toBeCloseTo(
      1 * 0.5e-6 + 100_000 * 0.05e-6,
      9,
    );
  });
  it("Opus 5.5 reads its cache at 0.05x", () => {
    expect(priceUsd("claude-opus-5-5", { input: 1_000_000, cacheRead: 1_000_000 })).toBeCloseTo(
      0.2,
      9,
    );
  });
});

describe("priced", () => {
  it("a free call costs 0 and keeps the list price", () => {
    const u = priced("openai/gpt-oss-120b", { input: 1_000_000 }, { free: true });
    expect(u).toEqual({ input: 1_000_000, usd: 0, free: true, listUsd: 0.15 });
  });
  it("a model with no row keeps its tokens and no usd", () => {
    expect(priced("mystery", { input: 5 })).toEqual({ input: 5 });
  });
});

it("speechUsd prices by the hour", () => {
  expect(speechUsd("groq:whisper-large-v3-turbo", 3600)).toBeCloseTo(0.04, 9);
  expect(speechUsd("nope", 60)).toBeUndefined();
});

it("addUsage sums each field either side has", () => {
  expect(addUsage({ input: 1, usd: 0.5 }, { input: 2, output: 3 })).toEqual({
    input: 3,
    usd: 0.5,
    output: 3,
  });
  expect(addUsage(undefined, { input: 1 })).toEqual({ input: 1 });
  expect(addUsage({ usd: 0, free: true }, { usd: 0, free: true })).toEqual({ usd: 0, free: true });
});

it("pricesText says each model's rates", () => {
  expect(pricesText("anthropic")).toContain("Haiku 5.5 $0.10 in, $0.50 out");
});
