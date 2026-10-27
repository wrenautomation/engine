import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Transient } from "../engine/transient.js";
import { endpoint, gatewayModel } from "./gateway-model.js";

describe("gatewayModel", () => {
  it("posts the prompt as one chat turn, parses the answer, keeps the tokens", async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const model = gatewayModel({
      url: "https://llm.example/",
      token: "t",
      fetchFn: async (u, init) => {
        seen.push({ url: String(u), init });
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '```json\n{"next":"stop","why":"enough"}\n```' } }],
            usage: { prompt_tokens: 12, completion_tokens: 5 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    const a = await model.ask("decide", z.object({ next: z.string(), why: z.string() }));
    expect(model.id).toBe("gateway:free");
    expect(a).toEqual({
      value: { next: "stop", why: "enough" },
      usage: { input: 12, output: 5, usd: 0 },
    });
    expect(seen[0]?.url).toBe("https://llm.example/v1/chat/completions");
    expect(new Headers(seen[0]?.init?.headers).get("authorization")).toBe("Bearer t");
    expect(JSON.parse(String(seen[0]?.init?.body))).toMatchObject({
      model: "free",
      messages: [{ role: "user", content: "decide" }],
    });
  });
  it("takes the URL with or without its /v1", () => {
    expect(endpoint("https://llm.example/v1")).toBe("https://llm.example/v1/chat/completions");
    expect(endpoint("https://llm.example/")).toBe("https://llm.example/v1/chat/completions");
  });
  it("throws with the gateway's reason, a Transient on a 429", async () => {
    const model = gatewayModel({
      url: "https://llm.example",
      model: "gemini/flash",
      fetchFn: async () =>
        new Response(JSON.stringify({ error: { message: "faucet dry" } }), { status: 429 }),
    });
    const err = await model.ask("x", z.object({})).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Transient);
    expect((err as Error).message).toBe("gateway gemini/flash: HTTP 429 faucet dry");
  });
});
