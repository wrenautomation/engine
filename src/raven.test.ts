import { describe, expect, it } from "vitest";
import { fill, parseAnswer, scriptedModel } from "./model.js";
import { mergeProposals, plan, proposePrompt } from "./plan.js";
import { defaultPlanFile, PLAN_KINDS } from "./plans/index.js";
import { review } from "./review.js";
import { dedupeHits, triage } from "./triage.js";
import { type Ask, type Plan, PlanFile, type Proposal, type Round, z } from "./types.js";

const ask: Ask = {
  text: "how do staffing firms win repeat clients",
  kind: "web",
  known: ["referrals convert"],
};

describe("model seam", () => {
  it("parses the first JSON object out of fences and prose", () => {
    const shape = z.object({ queries: z.array(z.string()) });
    expect(parseAnswer('Sure:\n```json\n{"queries":["a"]}\n```\nDone.', shape)).toEqual({
      queries: ["a"],
    });
    expect(() => parseAnswer("no json here", shape)).toThrow(/no answer/);
    expect(() => parseAnswer('{"queries": 1}', shape)).toThrow(/no answer/);
  });

  it("fills marks and leaves unknown ones", () => {
    expect(fill("{a} and {b}", { a: "x" })).toBe("x and {b}");
  });
});

describe("plan files", () => {
  it("ship one valid default per kind, each naming the answer shape", () => {
    for (const k of PLAN_KINDS) {
      const f = PlanFile.parse(defaultPlanFile(k));
      expect(f.kind).toBe(k);
      expect(f.propose).toContain('"queries"');
      expect(f.triage).toContain('"hits"');
      expect(f.review).toContain('"next"');
    }
  });

  it("is a copy: a tuned file leaves the default as it was", () => {
    const f = defaultPlanFile("web");
    f.budget.queries = 99;
    expect(defaultPlanFile("web").budget.queries).toBe(3);
  });
});

describe("merge", () => {
  const human: Proposal = {
    from: "human",
    by: "will",
    queries: [
      { kind: "web", terms: "staffing repeat business survey", why: "has numbers" },
      { kind: "web", terms: "a", why: "" },
      { kind: "web", terms: "b", why: "" },
      { kind: "web", terms: "c", why: "" },
    ],
  };
  const ai: Proposal = {
    from: "ai",
    by: "m1",
    queries: [
      { kind: "web", terms: "Staffing  repeat business survey", why: "dup of the human one" },
      { kind: "web", terms: "d", why: "" },
      { kind: "web", terms: "e", why: "" },
      { kind: "web", terms: "f", why: "" },
    ],
  };

  it("puts human queries first, keeps them all, dedupes by terms, caps the model's", () => {
    const out = mergeProposals([ai, human], 2);
    expect(out.map((q) => q.terms)).toEqual([
      "staffing repeat business survey",
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
    expect(out[0]?.by).toBe("will");
    expect(out.filter((q) => q.from === "ai")).toHaveLength(2);
  });

  it("builds a plan with a snapshot; no model means only the proposals given", async () => {
    const model = scriptedModel([{ queries: [{ terms: "x y z", why: "fresh numbers" }] }], "m1");
    const p = await plan({
      ask,
      model,
      proposals: [human],
      now: () => new Date("2026-10-27T00:00:00Z"),
    });
    expect(p.queries.at(-1)).toMatchObject({ terms: "x y z", from: "ai", by: "m1", kind: "web" });
    expect(p.snapshot).toEqual({
      at: "2026-10-27T00:00:00.000Z",
      known: ["referrals convert"],
      planFile: { id: "raven/web", version: 1 },
      model: "m1",
      yieldRows: 0,
    });
    const byHand = await plan({ ask, model: null, proposals: [human] });
    expect(byHand.queries).toHaveLength(4);
    expect(byHand.snapshot.model).toBeNull();
  });

  it("narrows sources to the plan file's and never widens", async () => {
    const p = await plan({ ask, model: null, sources: ["exa", "bing"] });
    expect(p.sources).toEqual(["exa"]);
  });

  it("puts the ask, the known lines and the yield into the prompt", () => {
    const text = proposePrompt(
      ask,
      defaultPlanFile("web"),
      [{ source: "exa", hits: 9, reads: 3, proposed: 5, kept: 2 }],
      new Date("2026-01-01"),
    );
    expect(text).toContain(ask.text);
    expect(text).toContain("- referrals convert");
    expect(text).toContain("source=exa hits=9 reads=3 proposed=5 kept=2");
    expect(text).toContain("2026");
    expect(text).not.toMatch(/\{\w+\}/);
  });
});

describe("triage", () => {
  const p: Plan = {
    ask,
    round: 1,
    queries: [],
    sources: ["searxng"],
    budget: { queries: 3, reads: 1, rounds: 2 },
    snapshot: {
      at: "",
      known: [],
      planFile: { id: "raven/web", version: 1 },
      model: "m1",
      yieldRows: 0,
    },
  };

  it("dedupes by url and keeps every source", () => {
    const out = dedupeHits([
      { url: "https://a.example", title: "A", sources: ["exa"] },
      { url: "https://a.example", snippet: "s", sources: ["searxng", "exa"] },
      { url: "https://b.example", sources: [] },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ title: "A", snippet: "s", sources: ["exa", "searxng"] });
  });

  it("writes a skip for a hit the model left out, and caps reads at the budget", async () => {
    const model = scriptedModel([
      {
        hits: [
          { url: "https://a.example", read: true, why: "survey" },
          { url: "https://b.example", read: true, why: "also" },
        ],
      },
    ]);
    const out = await triage(
      [
        { url: "https://a.example", sources: [] },
        { url: "https://b.example", sources: [] },
        { url: "https://c.example", sources: [] },
      ],
      p,
      model,
    );
    expect(out.map((t) => [t.read, t.why])).toEqual([
      [true, "survey"],
      [false, "over the read budget (1)"],
      [false, "not named by the model"],
    ]);
    expect(await triage([], p, model)).toEqual([]);
  });
});

describe("review", () => {
  const round: Round = {
    ask,
    round: 1,
    budget: { queries: 3, reads: 6, rounds: 2 },
    hits: 10,
    reads: 4,
    proposed: 6,
    kept: 2,
    found: ["referrals convert"],
    notes: [],
  };

  it("stops on a spent round budget without asking the model", async () => {
    const e = await review({ ...round, round: 2 }, scriptedModel([]));
    expect(e).toMatchObject({ next: "stop", by: "raven:budget" });
  });

  it("takes the model's edge and defaults a back to fetch", async () => {
    expect(
      await review(round, scriptedModel([{ next: "again", why: "numbers missing" }], "m1")),
    ).toEqual({ next: "again", why: "numbers missing", from: "ai", by: "m1" });
    expect(
      await review(round, scriptedModel([{ next: "back", why: "exa was down" }])),
    ).toMatchObject({ next: "back", to: "fetch" });
  });
});
