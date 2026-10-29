import { describe, expect, it } from "vitest";
import { ageOf, defaultPlanFile, PLAN_KINDS, PlanFile, rulesOf } from "./plan.js";
import { dedupeHits, withPremises } from "./steps.js";

describe("plan files", () => {
  it("ship one valid default per kind, each with an age and rules", () => {
    for (const k of PLAN_KINDS) {
      const f = PlanFile.parse(defaultPlanFile(k));
      expect(f.kind).toBe(k);
      expect(ageOf(f)).toBeTruthy();
      expect(rulesOf(f).length).toBeGreaterThan(0);
    }
  });

  it("is a copy: a tuned file leaves the default as it was", () => {
    const f = defaultPlanFile("web");
    f.budget.queries = 99;
    expect(defaultPlanFile("web").budget.queries).toBe(3);
  });

  it("parses a stored file with the old prompts: they drop, the kind's rules fill in", () => {
    const { rules: _r, ...stock } = defaultPlanFile("video");
    const old = PlanFile.parse({ ...stock, propose: "p", triage: "t", review: "r" });
    expect(old).not.toHaveProperty("propose");
    expect(rulesOf(old)).toEqual(defaultPlanFile("video").rules);
  });

  it("parses a version 3 file: checks default to 3, age to its kind's", () => {
    const { age: _age, ...v3 } = defaultPlanFile("web");
    const old = PlanFile.parse({ ...v3, version: 3, budget: { queries: 3, reads: 6, rounds: 3 } });
    expect(old.budget.checks).toBe(3);
    expect(ageOf(old)).toContain("Prices");
  });
});

describe("plan inputs", () => {
  it("moves a known line with no source to the premises", () => {
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
  });

  it("dedupes hits by url and keeps every source", () => {
    const out = dedupeHits([
      { url: "https://a.example", title: "A", sources: ["exa"] },
      { url: "https://a.example", snippet: "s", sources: ["searxng", "exa"] },
      { url: "https://b.example", sources: [] },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ title: "A", snippet: "s", sources: ["exa", "searxng"] });
  });
});
