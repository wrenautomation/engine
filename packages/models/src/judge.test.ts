import { describe, expect, it } from "vitest";
import {
  choice,
  fakeJudge,
  JEV_MODEL,
  jevJudge,
  judgeFailure,
  judgeFromSpec,
  noul,
  score,
  top,
} from "./judge.js";

describe("jevJudge", () => {
  it("asks systemone and answers label probabilities, priced", async () => {
    let body: Record<string, unknown> = {};
    const judge = jevJudge({
      apiKey: "k",
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            model: JEV_MODEL,
            answers: {
              serves: { type: "noul", noul: 0.8 },
              side: {
                type: "choice",
                choice: "seller",
                confidence: 0.4,
                probabilities: { subject: 0.3, seller: 0.6, other: 0.1 },
              },
            },
            usage: { input_tokens: 1_000_000, output_tokens: 5 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    const r = await judge.judge(
      { ask: "x" },
      {
        serves: noul("Does it serve the ask?"),
        side: choice("Whose side?", { subject: null, seller: null, other: null }),
      },
    );
    expect(body.model).toBe(JEV_MODEL);
    expect(r.answers.serves.yes).toBeCloseTo(0.8);
    expect(r.answers.serves.no).toBeCloseTo(0.2);
    expect(top(r.answers.side)).toEqual(["seller", 0.6]);
    expect(r.usage.usd).toBeCloseTo(0.042);
  });

  it("sorts failures by status", () => {
    expect(judgeFailure({ status: 422 })).toBe("refused");
    expect(judgeFailure({ status: 402 })).toBe("key");
    expect(judgeFailure({ status: 503 })).toBe("down");
    expect(judgeFailure(new Error("socket"))).toBe("down");
  });
});

describe("fakeJudge", () => {
  it("gives even odds where respond is silent", async () => {
    const j = fakeJudge(() => ({ a: { yes: 0.9, no: 0.1 } }));
    const r = await j.judge(null, {
      a: noul("a?"),
      b: choice("b?", { x: null, y: null }),
      c: score("c?", ["low", "mid", "high"]),
    });
    expect(r.answers.a.yes).toBe(0.9);
    expect(r.answers.b).toEqual({ x: 0.5, y: 0.5 });
    expect(Object.keys(r.answers.c)).toEqual(["0", "1", "2"]);
  });
});

describe("judgeFromSpec", () => {
  it("reads the key and the model", () => {
    expect(judgeFromSpec("off", {})).toBeNull();
    expect(judgeFromSpec("jev", { TYPESAFE_API_KEY: "k" })?.id).toBe(JEV_MODEL);
    expect(judgeFromSpec("jev:jev-2", { TYPESAFE_API_KEY: "k" })?.id).toBe("jev-2");
    expect(() => judgeFromSpec("jev", {})).toThrow(/TYPESAFE_API_KEY/);
    expect(() => judgeFromSpec("gpt", {})).toThrow(/unknown judge/);
  });
});
