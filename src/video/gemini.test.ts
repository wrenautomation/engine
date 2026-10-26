import { describe, expect, it } from "vitest";
import { askGemini } from "./gemini.js";

describe("askGemini limits", () => {
  const quick = { pause: async () => {} };
  const stalls = ((_url: string, init: RequestInit) =>
    new Promise((_, reject) =>
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
    )) as unknown as typeof fetch;

  it("gives up on a call that never answers, and on an ask that outlasts its budget", async () => {
    const began = Date.now();
    const r = await askGemini({}, ["k"], stalls, "t", { callMs: 20, askMs: 150, ...quick });
    expect(r).toMatchObject({ unread: expect.stringMatching(/timeout|aborted/i) });
    expect(Date.now() - began).toBeLessThan(2_000);
  });

  it("treats a dropped connection as a refusal and asks the next key", async () => {
    const keys: string[] = [];
    const flaky = (async (_url: string, init: RequestInit) => {
      keys.push((init.headers as Record<string, string>)["x-goog-api-key"] as string);
      if (keys.length === 1) throw new TypeError("fetch failed");
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: "hello" }] } }] }),
      );
    }) as typeof fetch;
    expect(await askGemini({}, ["a", "b"], flaky, "t", quick)).toEqual({ text: "hello" });
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("says it timed out when its time is gone before it asked", async () => {
    const busy = (async () => new Response("{}", { status: 503 })) as unknown as typeof fetch;
    expect(await askGemini({}, ["k"], busy, "t", { askMs: 0, ...quick })).toEqual({
      unread: "timed out",
    });
  });
});
