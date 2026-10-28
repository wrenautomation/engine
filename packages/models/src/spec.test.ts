import { describe, expect, it } from "vitest";
import { claudeCode, readOutput } from "./command.js";
import { modelFromSpec } from "./spec.js";

describe("modelFromSpec", () => {
  const vars = {
    ANTHROPIC_API_KEY: "a",
    NUM_GROQ: "2",
    GROQ_API_KEY_1: "g1",
    GROQ_API_KEY_2: "g2",
    GEMINI_API_KEY: "m",
    COHERE_API_KEY: "c",
    OPENROUTER_API_KEY: "o",
    WREN_LLM_GATEWAY_URL: "https://llm.example.com",
    WREN_LLM_GATEWAY_TOKEN: "t",
  };
  it.each([
    ["fake", "fake"],
    ["claude-code", "claude-code:sonnet"],
    ["claude-code:opus", "claude-code:opus"],
    ["anthropic", "claude-haiku-5-5"],
    ["anthropic:sonnet", "claude-sonnet-5-5"],
    ["anthropic:claude-opus-5-5", "claude-opus-5-5"],
    ["gateway", "gateway:free"],
    ["gateway:cohere", "gateway:cohere"],
    ["gemini", "google:gemini-3.5-flash"],
    ["cohere", "cohere:command-a-03-2025"],
    ["groq", "groq:openai/gpt-oss-120b"],
    ["openrouter:google/gemma-4-31b-it:free", "openrouter:google/gemma-4-31b-it:free"],
    ["command:cat", "cat"],
  ])("%s is %s", (spec, id) => {
    expect(modelFromSpec(spec, vars).id).toBe(id);
  });
  it("an unknown name throws with the list", () => {
    expect(() => modelFromSpec("llama", vars)).toThrow("fake");
  });
  it("a missing key names the setting", () => {
    expect(() => modelFromSpec("mistral", vars)).toThrow("MISTRAL_API_KEY");
    expect(() => modelFromSpec("gateway", {})).toThrow("WREN_LLM_GATEWAY_URL");
  });
});

describe("command models", () => {
  it("readOutput reads Claude Code's envelope, cache tokens inside input", () => {
    const out = readOutput(
      JSON.stringify({
        type: "result",
        subtype: "success",
        result: "hi",
        total_cost_usd: 0.02,
        usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 90 },
      }),
    );
    expect(out.text).toBe("hi");
    expect(out.usage).toMatchObject({ input: 100, output: 3, cacheRead: 90, usd: 0.02 });
    expect(readOutput("plain text").text).toBe("plain text");
  });

  it("claudeCode runs with tools off, costs 0 and keeps the list price", async () => {
    let args: string[] = [];
    let stdin = "";
    const m = claudeCode("haiku", {
      run: async (a, s) => {
        args = a;
        stdin = s;
        return JSON.stringify({ subtype: "success", result: '{"n": 1}', total_cost_usd: 0.01 });
      },
    });
    const r = await m.complete({ prompt: "give n", system: "only json" });
    expect(r.usage).toMatchObject({ usd: 0, free: true, listUsd: 0.01 });
    expect(stdin).toContain("give n");
    expect(args).toContain("haiku");
  });

  it("claudeCode throws its error envelope", async () => {
    const m = claudeCode("haiku", {
      run: async () => JSON.stringify({ is_error: true, subtype: "error_max_turns", result: "" }),
    });
    await expect(m.complete("x")).rejects.toThrow();
  });
});
