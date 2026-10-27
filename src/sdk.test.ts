import { describe, expect, it } from "vitest";
import { Cut, InputRejected, Refused, Transient } from "./errors.js";
import { anthropic, compatible, gateway, gatewayBase } from "./providers.js";

type Seen = { url: string; body: Record<string, unknown>; headers: Headers };

const wire = (respond: () => Response | Promise<Response>) => {
  const seen: Seen[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? "{}")),
      headers: new Headers(init?.headers),
    });
    return respond();
  }) as typeof globalThis.fetch;
  return { seen, fetch };
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const message = (o: { text?: string; stop?: string; usage?: Record<string, number> } = {}) =>
  json({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    content: [{ type: "text", text: o.text ?? '{"ok": true}' }],
    stop_reason: o.stop ?? "end_turn",
    stop_sequence: null,
    usage: o.usage ?? { input_tokens: 10, output_tokens: 5 },
  });

describe("anthropic", () => {
  it("counts cache tokens inside input and prices each at its rate", async () => {
    const w = wire(() =>
      message({
        usage: {
          input_tokens: 100,
          output_tokens: 10,
          cache_read_input_tokens: 50,
          cache_creation_input_tokens: 20,
        },
      }),
    );
    const m = anthropic({ key: "k", fetch: w.fetch });
    const r = await m.complete({ prompt: "hi", system: "be brief", effort: "low" });
    expect(r.usage.input).toBe(170);
    expect(r.usage.cacheRead).toBe(50);
    expect(r.usage.cacheWrite).toBe(20);
    expect(r.usage.usd).toBeCloseTo((100 * 0.1 + 50 * 0.01 + 20 * 0.125 + 10 * 0.5) / 1e6, 12);
    expect(r.stop).toBe("end_turn");
    expect(m.id).toBe("claude-haiku-5-5");
    const body = w.seen[0]?.body as { system: { cache_control?: unknown }[]; model: string };
    expect(body.model).toBe("claude-haiku-5-5");
    expect(body.system[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(w.seen[0]?.headers.get("x-api-key")).toBe("k");
  });

  it("sends image and pdf parts as content blocks", async () => {
    const w = wire(() => message());
    const m = anthropic({ key: "k", model: "sonnet", fetch: w.fetch });
    await m.complete({
      prompt: [
        { type: "text", text: "what is this" },
        { type: "image", data: new Uint8Array([1, 2, 3]), mediaType: "image/png" },
        { type: "pdf", data: "JVBERg==" },
      ],
    });
    const content = (
      w.seen[0]?.body as { messages?: { content: { type: string }[] }[] } | undefined
    )?.messages?.[0]?.content;
    expect(content?.map((c) => c.type)).toEqual(["text", "image", "document"]);
  });

  it("an output cap stop is a Cut with the text so far and its priced usage", async () => {
    const w = wire(() => message({ text: '{"partial":', stop: "max_tokens" }));
    const err = await anthropic({ key: "k", fetch: w.fetch })
      .complete("hi")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Cut);
    expect((err as Cut).partial).toBe('{"partial":');
    expect((err as Cut).usage?.usd).toBeGreaterThan(0);
  });

  it("maps 429, 401, 400 and 529 by what the caller does next", async () => {
    const at = (status: number, headers: Record<string, string> = {}) =>
      anthropic({
        key: "k",
        fetch: wire(() =>
          json({ type: "error", error: { type: "x", message: "no" } }, status, headers),
        ).fetch,
      })
        .complete("hi")
        .catch((e: unknown) => e);
    const busy = await at(429, { "retry-after": "30" });
    expect(busy).toBeInstanceOf(Transient);
    const wait = Date.parse((busy as Transient).retryAfter ?? "") - Date.now();
    expect(wait).toBeGreaterThan(25_000);
    expect(wait).toBeLessThan(35_000);
    expect(await at(401)).toBeInstanceOf(Refused);
    expect(await at(400)).toBeInstanceOf(InputRejected);
    expect(await at(529)).toBeInstanceOf(Transient);
  });

  it("a dropped connection is Transient", async () => {
    const m = anthropic({
      key: "k",
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    await expect(m.complete("hi")).rejects.toBeInstanceOf(Transient);
  });

  it("a key ring moves past a refused key", async () => {
    let n = 0;
    const fetch = (async (_: string | URL | Request, init?: RequestInit) => {
      n++;
      const key = new Headers(init?.headers).get("x-api-key");
      return key === "bad"
        ? json({ type: "error", error: { type: "auth", message: "no" } }, 401)
        : message({ text: "fine" });
    }) as typeof globalThis.fetch;
    const m = anthropic({ key: ["bad", "good"], fetch });
    expect((await m.complete("hi")).text).toBe("fine");
    expect(n).toBe(2);
  });
});

const completion = (o: { text?: string; finish?: string } = {}) =>
  json({
    id: "c1",
    object: "chat.completion",
    created: 1,
    model: "m",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: o.text ?? "hello" },
        finish_reason: o.finish ?? "stop",
      },
    ],
    usage: { prompt_tokens: 1_000_000, completion_tokens: 0 },
  });

describe("gateway and compatible vendors", () => {
  it("gatewayBase does not double /v1", () => {
    expect(gatewayBase("https://llm.example.com")).toBe("https://llm.example.com/v1");
    expect(gatewayBase("https://llm.example.com/v1/")).toBe("https://llm.example.com/v1");
  });

  it("the gateway's free alias costs 0 and adds thinking room", async () => {
    const w = wire(() => completion());
    const m = gateway({ url: "https://llm.example.com/v1", token: "t", fetch: w.fetch });
    const r = await m.complete({ prompt: "hi", maxTokens: 400 });
    expect(r.usage).toMatchObject({ usd: 0, free: true });
    expect(w.seen[0]?.url).toBe("https://llm.example.com/v1/chat/completions");
    expect(w.seen[0]?.headers.get("authorization")).toBe("Bearer t");
    expect(w.seen[0]?.body.max_tokens).toBe(2048 + 4096);
    expect(m.id).toBe("gateway:free");
  });

  it("finish_reason length is a Cut", async () => {
    const m = gateway({
      url: "https://llm.example.com",
      token: "t",
      fetch: wire(() => completion({ text: "{", finish: "length" })).fetch,
    });
    await expect(m.complete("hi")).rejects.toBeInstanceOf(Cut);
  });

  it("Groq's free ring costs 0 and keeps the list price; a text-only model refuses an image", async () => {
    const m = compatible("groq", { key: "g", fetch: wire(() => completion()).fetch });
    const r = await m.complete("hi");
    expect(r.usage).toMatchObject({ usd: 0, free: true, listUsd: 0.15 });
    expect(m.id).toBe("groq:openai/gpt-oss-120b");
    await expect(
      m.complete({ prompt: [{ type: "image", data: "AA", mediaType: "image/png" }] }),
    ).rejects.toThrow("takes no image part");
  });

  it("OpenRouter is free only on a :free model", async () => {
    const fetch = wire(() => completion()).fetch;
    expect((await compatible("openrouter", { key: "o", fetch }).complete("x")).usage.free).toBe(
      true,
    );
    const paid = compatible("openrouter", { key: "o", model: "openai/gpt-oss-120b", fetch });
    expect((await paid.complete("x")).usage).toMatchObject({ usd: 0.15 });
  });
});
