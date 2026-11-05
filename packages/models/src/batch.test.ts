import { describe, expect, it } from "vitest";
import { anthropicBatch, type BatchWire, batchParams } from "./batch.js";
import { priceUsd } from "./prices.js";

const counts = (o: Partial<Record<string, number>> = {}) => ({
  processing: 0,
  succeeded: 0,
  errored: 0,
  canceled: 0,
  expired: 0,
  ...o,
});

function fakeWire(status: "in_progress" | "ended") {
  const sent: unknown[] = [];
  const wire = {
    create: async (p: unknown) => {
      sent.push(p);
      return { id: "msgbatch_1" };
    },
    retrieve: async (id: string) => ({
      id,
      processing_status: status,
      created_at: "2026-11-05T00:00:00Z",
      ended_at: status === "ended" ? "2026-11-05T00:10:00Z" : null,
      request_counts:
        status === "ended" ? counts({ succeeded: 1, errored: 1 }) : counts({ processing: 2 }),
    }),
    results: async () =>
      (async function* () {
        yield {
          custom_id: "a",
          result: {
            type: "succeeded",
            message: {
              id: "msg_1",
              model: "claude-haiku-5-5",
              stop_reason: "end_turn",
              content: [{ type: "text", text: "yes" }],
              usage: {
                input_tokens: 1000,
                output_tokens: 10,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
              },
            },
          },
        };
        yield {
          custom_id: "b",
          result: {
            type: "errored",
            error: { error: { type: "invalid_request_error", message: "too long" } },
          },
        };
      })(),
  } as unknown as BatchWire;
  return { wire, sent };
}

describe("anthropicBatch", () => {
  it("sends each item as Messages params under its id", async () => {
    const { wire, sent } = fakeWire("in_progress");
    const b = anthropicBatch({ key: "k", wire });
    expect(await b.batch([{ id: "a", request: { prompt: "is it?", system: "judge" } }])).toEqual({
      id: "msgbatch_1",
    });
    expect(sent).toEqual([
      {
        requests: [
          {
            custom_id: "a",
            params: {
              model: "claude-haiku-5-5",
              max_tokens: 8192,
              system: [{ type: "text", text: "judge", cache_control: { type: "ephemeral" } }],
              messages: [{ role: "user", content: "is it?" }],
            },
          },
        ],
      },
    ]);
  });

  it("refuses bad or repeated ids and empty batches", async () => {
    const b = anthropicBatch({ key: "k", wire: fakeWire("in_progress").wire });
    await expect(b.batch([])).rejects.toThrow("no items");
    await expect(b.batch([{ id: "a b", request: "x" }])).rejects.toThrow("bad item id");
    await expect(
      b.batch([
        { id: "a", request: "x" },
        { id: "a", request: "y" },
      ]),
    ).rejects.toThrow("twice");
  });

  it("says running until the batch ends", async () => {
    const b = anthropicBatch({ key: "k", wire: fakeWire("in_progress").wire });
    expect(await b.batchResults("msgbatch_1")).toEqual({
      id: "msgbatch_1",
      state: "running",
      counts: { running: 2, ok: 0, failed: 0 },
    });
  });

  it("answers each item at half the list price; a failed item carries why", async () => {
    const b = anthropicBatch({ key: "k", wire: fakeWire("ended").wire });
    const s = await b.batchResults("msgbatch_1");
    if (s.state !== "ended") throw new Error("not ended");
    expect(s.counts).toEqual({ running: 0, ok: 1, failed: 1 });
    const [a, e] = s.answers;
    expect(a?.reply?.text).toBe("yes");
    expect(a?.reply?.ms).toBe(600_000);
    const list = priceUsd("claude-haiku-5-5", { input: 1000, output: 10 }) ?? 0;
    expect(a?.reply?.usage.usd).toBeCloseTo(list / 2, 12);
    expect(e).toEqual({ id: "b", error: "invalid_request_error: too long" });
  });
});

describe("batchParams", () => {
  it("carries parts, effort and the token floor", () => {
    const p = batchParams("claude-sonnet-5-5", {
      prompt: [
        { type: "text", text: "read" },
        { type: "image", data: new Uint8Array([1, 2]), mediaType: "image/png" },
        { type: "pdf", data: "https://example.com/a.pdf" },
      ],
      maxTokens: 100,
      effort: "low",
    });
    expect(p.max_tokens).toBe(2048);
    expect(p.output_config).toEqual({ effort: "low" });
    expect(p.messages[0]?.content).toEqual([
      { type: "text", text: "read" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AQI=" } },
      { type: "document", source: { type: "url", url: "https://example.com/a.pdf" } },
    ]);
  });

  it("refuses a part Claude does not take", () => {
    expect(() =>
      batchParams("claude-haiku-5-5", {
        prompt: [{ type: "audio", data: new Uint8Array(), mediaType: "audio/wav" }],
      }),
    ).toThrow();
  });
});
