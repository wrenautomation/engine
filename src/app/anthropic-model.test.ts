import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Transient } from "../engine/transient.js";
import { anthropicId, anthropicModel } from "./anthropic-model.js";

const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

describe("anthropicModel", () => {
  it("names the model by alias or id", () => {
    expect(anthropicId()).toBe("claude-haiku-5-5");
    expect(anthropicId("sonnet")).toBe("claude-sonnet-5-5");
    expect(anthropicId("claude-opus-5-5")).toBe("claude-opus-5-5");
  });
  it("sends one user turn, parses the answer, keeps the tokens", async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const model = anthropicModel({
      apiKey: "k",
      fetchFn: async (u, init) => {
        seen.push({ url: String(u), init });
        return reply({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-haiku-5-5",
          content: [{ type: "text", text: 'Sure.\n```json\n{"next":"stop","why":"enough"}\n```' }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 12, output_tokens: 5 },
        });
      },
    });
    const a = await model.ask("decide", z.object({ next: z.string(), why: z.string() }));
    expect(model.id).toBe("claude-haiku-5-5");
    expect(a).toEqual({ value: { next: "stop", why: "enough" }, usage: { input: 12, output: 5 } });
    expect(seen[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(new Headers(seen[0]?.init?.headers).get("authorization")).toContain("k");
    expect(JSON.parse(String(seen[0]?.init?.body))).toMatchObject({
      model: "claude-haiku-5-5",
      max_tokens: 8192,
      messages: [{ role: "user", content: "decide" }],
    });
  });
  it("says so when the cap cut the answer", async () => {
    const model = anthropicModel({
      apiKey: "k",
      maxTokens: 50,
      fetchFn: async () =>
        reply({
          id: "msg_2",
          type: "message",
          role: "assistant",
          model: "claude-haiku-5-5",
          content: [{ type: "text", text: '{"findings": [{"text": "half a' }],
          stop_reason: "max_tokens",
          stop_sequence: null,
          usage: { input_tokens: 12, output_tokens: 50 },
        }),
    });
    const err = await model.ask("extract", z.object({})).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(Transient);
    expect((err as Error).message).toBe(
      "anthropic claude-haiku-5-5: the answer was cut at 50 output tokens (max_tokens 50)",
    );
  });
  it("turns a 429 with retry-after into a Transient, a 400 into a plain error", async () => {
    const at = (status: number, headers: Record<string, string> = {}) =>
      anthropicModel({
        apiKey: "k",
        model: "sonnet",
        fetchFn: async () =>
          reply({ type: "error", error: { type: "x", message: "slow down" } }, status, headers),
      });
    const before = Date.now();
    const err = await at(429, { "retry-after": "30" })
      .ask("x", z.object({}))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Transient);
    expect((err as Error).message).toContain("anthropic claude-sonnet-5-5: HTTP 429");
    const after = Date.parse((err as Transient).retryAfter ?? "");
    expect(after - before).toBeGreaterThanOrEqual(29_000);
    expect(after - before).toBeLessThanOrEqual(31_000);
    const bad = await at(400)
      .ask("x", z.object({}))
      .catch((e: unknown) => e);
    expect(bad).not.toBeInstanceOf(Transient);
    expect((bad as Error).message).toContain("HTTP 400");
  });
});
