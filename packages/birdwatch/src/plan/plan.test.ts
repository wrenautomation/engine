import { scriptedModel } from "@wrenautomation/models";
import { describe, expect, it } from "vitest";
import { fill } from "./model.js";
import { mergeProposals, plan, proposePrompt } from "./plan.js";
import { defaultPlanFile, PLAN_KINDS } from "./plans/index.js";
import { renderKnown, withPremises } from "./render.js";
import { review, reviewPrompt } from "./review.js";
import { dedupeHits, SKIPPED, triage, triagePrompt } from "./triage.js";
import { Ask, type Plan, PlanFile, type Proposal, Round } from "./types.js";

const ask: Ask = {
  text: "how do staffing firms win repeat clients",
  kind: "web",
  known: ["referrals convert"],
  premises: [],
  steer: [],
  open: [],
  criteria: [],
};

describe("fill", () => {
  it("moves a known line with no source to the premises, and renders them apart", () => {
    const split = withPremises({
      known: [
        "referrals convert",
        "a rate (https://a.example/x)",
        "a finding 01M61SBB47Q88Y4D5TV8PZ1WH4",
      ],
      premises: ["the buyer is a coach"],
    });
    expect(split.known).toEqual([
      "a rate (https://a.example/x)",
      "a finding 01M61SBB47Q88Y4D5TV8PZ1WH4",
    ]);
    expect(split.premises).toEqual(["the buyer is a coach", "referrals convert"]);
    expect(withPremises(split)).toEqual(split);
    expect(renderKnown(split)).toBe(
      "- a rate (https://a.example/x)\n- a finding 01M61SBB47Q88Y4D5TV8PZ1WH4\nTaken as given, with no source (test each one: it may be wrong):\n- the buyer is a coach\n- referrals convert",
    );
    expect(renderKnown({ known: [], premises: [] })).toBe("(nothing)");
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
      planFile: { id: "birdwatch/web", version: 6 },
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
    expect(text).not.toContain("The person says");
  });

  it("renders what the person says first in every prompt, only when there is something", () => {
    const steered: Ask = { ...ask, steer: ["numbers only", "skip vendor pages"] };
    const block = "The person says:\n- numbers only\n- skip vendor pages\nKnown already";
    expect(proposePrompt(steered, defaultPlanFile("web"), [], new Date())).toContain(block);
    const p: Plan = {
      ask: steered,
      round: 1,
      queries: [],
      sources: [],
      budget: { queries: 3, reads: 1, rounds: 2, checks: 3 },
      snapshot: {
        at: "",
        known: [],
        planFile: { id: "birdwatch/web", version: 3 },
        model: "m1",
        yieldRows: 0,
      },
    };
    expect(
      triagePrompt([{ url: "https://a.example", sources: [] }], p, defaultPlanFile("web"), []),
    ).toContain(block);
    const r: Round = {
      ask: steered,
      round: 1,
      budget: p.budget,
      hits: 0,
      reads: 0,
      proposed: 0,
      kept: 0,
      found: [],
      notes: [],
      verdicts: [],
      gaps: [],
      checks: [],
      earlier: [],
    };
    expect(reviewPrompt(r, defaultPlanFile("web"))).toContain(
      "The person says:\n- numbers only\n- skip vendor pages\nRound 1",
    );
    expect(Ask.parse({ text: "x", kind: "web" }).steer).toEqual([]);

    // The person's tests ride the steer slot; a hit shows the judge's odds as a hint.
    const tested: Plan = {
      ...p,
      ask: { ...steered, criteria: [{ name: "code", question: "Is the code released?" }] },
    };
    const text = triagePrompt(
      [{ url: "https://a.example", sources: [], odds: { serves: 0.08, code: 0.912 } }],
      tested,
      defaultPlanFile("web"),
      [],
    );
    expect(text).toContain(
      "- skip vendor pages\nThe person's tests of a good source:\n- code: Is the code released?\nKnown already",
    );
    expect(text).toContain("judge (a cheap model's yes odds, a hint): serves 0.08, code 0.91");
  });
});

describe("triage", () => {
  const p: Plan = {
    ask,
    round: 1,
    queries: [],
    sources: ["searxng"],
    budget: { queries: 3, reads: 1, rounds: 2, checks: 3 },
    snapshot: {
      at: "",
      known: [],
      planFile: { id: "birdwatch/web", version: 2 },
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

  it("takes a skip without why as the model's skip, and a read without one as a read", async () => {
    const model = scriptedModel([
      {
        hits: [
          { url: "https://a.example", read: false },
          { url: "https://b.example", read: true, why: "  " },
        ],
      },
    ]);
    const out = await triage(
      [
        { url: "https://a.example", sources: [] },
        { url: "https://b.example", sources: [] },
      ],
      p,
      model,
    );
    expect(out.map((t) => [t.read, t.why])).toEqual([
      [false, SKIPPED],
      [true, "read"],
    ]);
    expect(defaultPlanFile("web").triage).toContain('A skip has no "why"');
  });
});

describe("review", () => {
  const round: Round = {
    ask,
    round: 1,
    budget: { queries: 3, reads: 6, rounds: 2, checks: 3 },
    hits: 10,
    reads: 4,
    proposed: 6,
    kept: 2,
    found: ["referrals convert"],
    notes: [],
    verdicts: [
      { url: "https://a.example/survey", quality: "rich", gap: "no cost per hire" },
      { url: "https://b.example/ad", quality: "off" },
    ],
    gaps: ['fetch: query "staffing repeat clients": no new hits', "william: no UK numbers yet"],
    checks: ["ok: referrals convert. The quote says so."],
    earlier: [],
  };

  it("shows new hits and kept findings round by round: the trend is the review's to weigh", () => {
    expect(reviewPrompt(round, defaultPlanFile("web"))).toContain("Hits 10 new, reads");
    const third = {
      ...round,
      round: 3,
      earlier: [
        { hits: 40, kept: 6 },
        { hits: 15, kept: 3 },
      ],
    };
    const p = reviewPrompt(third, defaultPlanFile("web"));
    expect(p).toContain("Hits 10 new (earlier rounds: 40, 15), reads");
    expect(p).toContain("kept 2 (earlier rounds: 6, 3).");
    expect(Round.parse({ ...round, earlier: undefined }).earlier).toEqual([]);
  });

  it("shows the gaps, the checks and the kind's word on age", () => {
    const p = reviewPrompt(round, defaultPlanFile("web"));
    expect(p).toContain(
      'Gaps (the step or the person, then what is missing):\n- fetch: query "staffing repeat clients": no new hits\n- william: no UK numbers yet',
    );
    expect(p).toContain("- ok: referrals convert. The quote says so.");
    expect(p).toContain("- Age: Prices, tools and numbers that move");
  });

  it("parses a version 3 plan file: checks default to 3, age to its kind's", () => {
    const { age: _age, ...v3 } = defaultPlanFile("web");
    const old = PlanFile.parse({ ...v3, version: 3, budget: { queries: 3, reads: 6, rounds: 3 } });
    expect(old.budget.checks).toBe(3);
    expect(reviewPrompt(round, { ...old, review: "{age}" })).toContain("- Age: Prices");
  });

  it("puts what the last round left open before what is known", () => {
    const p = proposePrompt(
      { ...ask, open: ["no cost per hire"] },
      defaultPlanFile("web"),
      [],
      new Date(),
    );
    expect(p).toContain(
      "The last round left open (plan for these first):\n- no cost per hire\nKnown already",
    );
  });

  it("shows the verdicts, one line per read, and parses a round without them", () => {
    const p = reviewPrompt(round, defaultPlanFile("web"));
    expect(p).toContain(
      "- https://a.example/survey: rich. no cost per hire\n- https://b.example/ad: off",
    );
    expect(Round.parse({ ...round, verdicts: undefined }).verdicts).toEqual([]);
  });

  it("takes the model's edge on the last budgeted round too: the budget is the runner's guard rail", async () => {
    const e = await review(
      { ...round, round: 2 },
      scriptedModel([{ next: "again", why: "no cost per hire" }], "m1"),
    );
    expect(e).toEqual({ next: "again", why: "no cost per hire", from: "ai", by: "m1" });
    expect(reviewPrompt({ ...round, round: 2 }, defaultPlanFile("web"))).not.toContain(
      "last round",
    );
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
