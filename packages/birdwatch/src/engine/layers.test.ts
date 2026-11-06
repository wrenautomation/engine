import { describe, expect, it } from "vitest";
import type { Brief } from "./agent.js";
import { briefIndex, briefPart, INDEX_TOP } from "./layers.js";

const finding = (i: number, round: number) => ({
  id: `f${i}`,
  round,
  text: `finding ${i}`,
  quote: `quote ${i}`,
  url: `https://example.com/${i}`,
});

// a long run: three rounds, many findings, checks, hits and known lines
const long = {
  run: "r1",
  round: 3,
  next: { round: 3, step: "plan" },
  note: null,
  ask: { text: "an ask", kind: "web", known: Array.from({ length: 400 }, (_, i) => `known ${i}`) },
  edges: [
    { round: 1, next: "again", why: "spend still thin", by: "a" },
    { round: 2, next: "again", why: "reach next", by: "a" },
  ],
  findings: {
    kept: [
      ...Array.from({ length: 250 }, (_, i) => finding(i, 1)),
      ...Array.from({ length: 30 }, (_, i) => finding(300 + i, 3)),
    ],
    dropped: 7,
  },
  checks: Array.from({ length: 300 }, (_, i) => ({ on: `f${i}`, ok: i % 10 !== 0, why: "why" })),
  patterns: [{ id: "p1", round: 1, text: "a pattern", findings: ["f1", "f2"] }],
  recalled: Array.from({ length: 20 }, (_, i) => ({ finding: `x${i}` })),
  hits: {
    uncalled: Array.from({ length: 90 }, (_, i) => ({ id: `h${i}` })),
    toRead: [],
    read: 10,
    total: 100,
  },
  documents: { toExtract: [], unclassed: [], total: 40 },
  verdicts: [],
  unfollowed: [],
  people: [],
  authors: [],
  surveys: [],
  children: [],
  yield: [
    { source: "searxng", hits: 1, reads: 1, proposed: 1, kept: 1 },
    { by: "agent", hits: 1, reads: 1, proposed: 1, kept: 1 },
  ],
} as unknown as Brief;

describe("brief layers", () => {
  it("the index folds earlier rounds and heads each long list, whatever the run's size", () => {
    const ix = briefIndex(long);
    expect(ix.rounds).toEqual([
      {
        round: 1,
        edge: { next: "again", why: "spend still thin" },
        patterns: ["p1"],
        findings: 250,
      },
      { round: 2, edge: { next: "again", why: "reach next" }, patterns: [], findings: 0 },
    ]);
    expect(ix.findings).toEqual({ kept: 280, dropped: 7, thisRound: 30 });
    expect(ix.checks).toEqual({ ok: 270, failed: 30 });
    expect(ix.ask?.known).toBe(400);
    expect(ix.hits.uncalled).toHaveLength(INDEX_TOP);
    expect(ix.yield).toEqual([long.yield[0]]);
    const uncalled = ix.parts.find((p) => p.part === "uncalled");
    expect(uncalled).toMatchObject({
      shown: INDEX_TOP,
      total: 90,
      read: "birdwatch brief r1 --part uncalled",
    });
    expect(JSON.stringify(ix).length).toBeLessThan(JSON.stringify(long).length / 5);
  });

  it("a part reads this round by default, any round on ask, a page at a time", () => {
    expect(briefPart(long, "findings").total).toBe(30);
    const one = briefPart(long, "findings", { round: 1 });
    expect(one).toMatchObject({ round: 1, total: 250, from: 0 });
    expect(one.rows).toHaveLength(100);
    expect(one.next).toBe("birdwatch brief r1 --part findings --round 1 --from 100");
    const last = briefPart(long, "findings", { round: 1, from: 200 });
    expect(last.rows).toHaveLength(50);
    expect(last.next).toBeNull();
    expect(briefPart(long, "findings", { round: "all" }).total).toBe(280);
    // failed checks first
    expect((briefPart(long, "checks").rows[0] as { ok: boolean }).ok).toBe(false);
    expect(() => briefPart(long, "nope")).toThrow(/no part nope/);
  });
});
