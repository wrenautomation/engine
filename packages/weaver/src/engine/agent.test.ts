import { claimExtractor } from "@wrenautomation/falcon/document";
import { fakeModel, type Model } from "@wrenautomation/models";
import { defaultPlanFile } from "@wrenautomation/raven";
import { describe, expect, it } from "vitest";
import { countingIds } from "../ledger/ids.js";
import { MemoryLedger } from "../ledger/memory.js";
import {
  add,
  brief,
  check,
  extract,
  open,
  planRound,
  search,
  searchTree,
  tunePlan,
  type Who,
} from "./agent.js";
import { type Deps, registry, type Source } from "./ports.js";
import { run } from "./runner.js";
import { fold } from "./state.js";

const pages: Record<string, string> = {
  "https://a.example/one":
    "A 2025 survey of 412 firms found 38% of placements came from repeat clients.",
  "https://a.example/two": "Nothing here.",
  "https://b.example/four": "The speaker says a weekly call keeps a client for 3 more years.",
};

const fake: Source = {
  name: "fake",
  kind: "search",
  cost: "free",
  search: async (q) =>
    (q.terms === "a" ? ["https://a.example/one", "https://a.example/two"] : []).map((url) => ({
      url,
      title: url,
    })),
};
const opener: Source = {
  name: "opener",
  kind: "open",
  cost: "free",
  open: async (h) => {
    const text = pages[h.url];
    if (!text) throw new Error("not on file");
    return { url: h.url, media: "text", text };
  },
};

const planFile = {
  ...defaultPlanFile("web"),
  sources: ["fake", "opener"],
  budget: { queries: 1, reads: 1, rounds: 1, checks: 2 },
};

/** The extractor's answers by the page's text, then the check's. */
const model: Model = fakeModel((prompt) => {
  if (prompt.startsWith("You check")) return JSON.stringify({ ok: true, why: "backed" });
  if (prompt.includes("412 firms"))
    return JSON.stringify({
      findings: [
        {
          text: "38% of placements came from repeat clients.",
          quote: "38% of placements came from repeat clients",
        },
        { text: "Half came from ads.", quote: "not on the page" },
      ],
    });
  if (prompt.includes("weekly call"))
    return JSON.stringify({
      findings: [
        {
          text: "A weekly call keeps a client 3 more years.",
          quote: "a weekly call keeps a client for 3 more years",
        },
      ],
    });
  throw new Error(`no answer for: ${prompt.slice(0, 40)}`);
}, "m");

const deps = (): Deps => {
  let t = 0;
  return {
    sources: registry(fake, opener),
    ledger: new MemoryLedger(),
    model,
    extractor: claimExtractor,
    clock: () => new Date(Date.UTC(2026, 9, 28, 10, 0, ++t)),
    ids: countingIds(),
    runner: "claude-code",
  };
};
const agent: Who = { from: "ai", by: "claude-code" };
const will: Who = { from: "human", by: "will" };

describe("agent commands", () => {
  it("drives a run step by step; the runner then has nothing to do", async () => {
    const d = deps();
    const planned = await planRound(d, {
      ask: { text: "how do staffing firms win repeat clients", kind: "web" },
      planFile,
      model: "m",
    });
    expect(planned.step).toBe("plan");
    expect(planned.wrote.map((r) => r.type)).toEqual(["snapshot", "done"]);
    const runId = planned.run;
    await expect(planRound(d, { run: runId, planFile, model: "m" })).rejects.toThrow("is planned");
    await expect(extract(d, runId)).resolves.toMatchObject({ ok: true });

    // Two queries past a budget of one: the budget is a guard rail, not a cap.
    const searched = await search(
      d,
      runId,
      [
        { terms: "a", why: "the ask's words" },
        { terms: "nothing", why: "a long shot" },
      ],
      agent,
    );
    expect(searched.step).toBe("fetch");
    const hits = searched.wrote.filter((r) => r.type === "hit");
    expect(hits.map((h) => h.type === "hit" && h.url)).toEqual([
      "https://a.example/one",
      "https://a.example/two",
    ]);
    expect(
      searched.wrote.filter((r) => r.type === "query").every((q) => q.by === "claude-code"),
    ).toBe(true);
    expect(searched.wrote.some((r) => r.type === "gap")).toBe(true);

    // Triage by hand: one kept, one dropped, one page the agent names itself.
    const [one, two] = hits.map((h) => h.id);
    if (!one || !two) throw new Error("the search wrote fewer than two hits");
    await add(d, runId, { type: "call", on: two, verdict: "drop", why: "empty" }, agent);
    const opened = await open(
      d,
      runId,
      { hits: [one], urls: ["https://b.example/four"], why: "numbers" },
      agent,
    );
    expect(opened.step).toBe("read");
    const docs = opened.wrote.filter((r) => r.type === "document");
    expect(docs.map((x) => x.type === "document" && x.url)).toEqual([
      "https://a.example/one",
      "https://b.example/four",
    ]);
    expect(docs.every((x) => "chars" in x && !("text" in x))).toBe(true);
    // The same page again: no new hit, no new read.
    const again = await open(d, runId, { urls: ["https://b.example/four"], why: "x" }, agent);
    expect(again.wrote.filter((r) => r.type === "hit" || r.type === "document")).toEqual([]);
    // An opener that came after the plan joins the run by name: a new snapshot says so.
    const late: Source = { ...opener, name: "late" };
    const seeker: Source = { ...fake, name: "seeker" };
    const dl = { ...d, sources: registry(...d.sources.values(), late, seeker) };
    const joined = await open(dl, runId, { with: ["late"] }, agent);
    expect(joined.step).toBe("read");
    const grew = fold(runId, await dl.ledger.trace(runId)).snapshot;
    expect(grew?.sources).toEqual(["fake", "opener", "late"]);
    expect(grew?.by).toBe(agent.by);
    await expect(open(dl, runId, { with: ["seeker"] }, agent)).rejects.toThrow("opens nothing");

    const extracted = await extract(d, runId);
    const findings = extracted.wrote.filter((r) => r.type === "finding");
    expect(findings.map((f) => f.type === "finding" && f.text)).toEqual([
      "38% of placements came from repeat clients.",
      "A weekly call keeps a client 3 more years.",
    ]);
    // The gate: a quote not on the page fails the add.
    const [docOne] = docs;
    if (!docOne) throw new Error("the open wrote no document");
    await expect(
      add(d, runId, { type: "finding", document: docOne.id, text: "x", quote: "not there" }, agent),
    ).rejects.toThrow("gate");
    const byHand = await add(
      d,
      runId,
      {
        type: "finding",
        document: docOne.id,
        text: "412 firms were surveyed in 2025.",
        quote: "A 2025 survey of 412 firms",
      },
      agent,
    );
    expect(byHand.record.type).toBe("finding");

    const checked = await check(d, runId);
    expect(checked.wrote.filter((r) => r.type === "check")).toHaveLength(2);

    // The agent's own check: a fail is a check record and a drop; a person's keep puts it back.
    const own = await add(
      d,
      runId,
      { type: "check", on: byHand.record.id, ok: false, why: "the quote is a fragment" },
      agent,
    );
    expect(own.record.type).toBe("check");
    expect((await brief(d, runId)).findings.kept.map((f) => f.id)).not.toContain(byHand.record.id);
    await add(d, runId, { type: "call", on: byHand.record.id, verdict: "keep", why: "fine" }, will);

    // A pattern rests on kept findings; its source count is counted, not claimed.
    const keptIds = (await brief(d, runId)).findings.kept.map((f) => f.id);
    const single = await add(
      d,
      runId,
      { type: "pattern", text: "Surveys agree.", findings: [keptIds[0] ?? ""] },
      agent,
    );
    expect(single.warnings).toEqual(["one source: a claim, not a pattern yet"]);
    const pattern = await add(
      d,
      runId,
      { type: "pattern", text: "  Repeat clients  drive placements. ", findings: keptIds },
      agent,
    );
    if (pattern.record.type !== "pattern") throw new Error("no pattern");
    expect(pattern.record.text).toBe("Repeat clients drive placements.");
    expect(pattern.record.findings).toEqual(keptIds);
    expect(pattern.record.sources).toBe(2);
    expect(pattern.warnings).toEqual([]);
    await expect(
      add(d, runId, { type: "pattern", text: "x", findings: ["nope"] }, agent),
    ).rejects.toThrow("no finding nope");

    await add(d, runId, { type: "steer", text: "numbers only" }, will);
    await expect(add(d, runId, { type: "steer", text: "x" }, agent)).rejects.toThrow("--human");
    const edge = await add(d, runId, { type: "edge", next: "again", why: "thin" }, agent);
    expect(edge.warnings[0]).toMatch(/past the budget/);

    const b = await brief(d, runId);
    // The edge said again: the pointer is at round 2's plan, the snapshot is round 1's.
    expect(b.round).toBe(2);
    expect(b.next).toEqual({ round: 2, step: "plan" });
    expect(b.open[0]).toContain("thin");
    expect(b.findings.kept).toHaveLength(3);
    expect(b.hits.uncalled).toEqual([]);
    expect(b.hits.toRead).toEqual([]);
    expect(b.documents.toExtract).toEqual([]);
    expect(b.steer).toEqual(["numbers only"]);
    expect(b.patterns.map((p) => [p.text, p.sources])).toEqual([
      ["Surveys agree.", 1],
      ["Repeat clients drive placements.", 2],
    ]);
    // Two searches, two reads, two extracts, two checks: every call a spend.
    expect(b.cost.total.calls).toBe(8);

    const round2 = await planRound(d, { run: runId, planFile, model: "m" });
    expect(round2.round).toBe(2);
    const snap = round2.wrote[0];
    if (snap?.type !== "snapshot") throw new Error("round 2 wrote no snapshot first");
    expect(snap.ask.steer).toEqual(["numbers only"]);
    expect(snap.ask.known).toHaveLength(3);
    expect(snap.ask.open[0]).toContain("thin");

    const stop = await add(d, runId, { type: "edge", next: "stop", why: "enough" }, agent);
    expect(stop.record.round).toBe(2);
    const before = (await d.ledger.trace(runId)).length;
    const result = await run(d, { resume: runId });
    expect(result.finished).toBe(true);
    expect((await d.ledger.trace(runId)).length).toBe(before);
    expect(fold(runId, await d.ledger.trace(runId)).next).toBeNull();
  });

  it("searches a tree one tier per call: first tries, then after triage the next try of each thin facet; a found hit ranks higher", async () => {
    const answers: Record<string, string[]> = {
      n1: ["https://x.example/a", "https://x.example/b"],
      n2: ["https://x.example/c", "https://x.example/d", "https://x.example/e"],
      h1: [
        "https://x.example/a",
        "https://x.example/f",
        "https://x.example/g",
        "https://x.example/h",
      ],
      c1: [],
      c2: ["https://x.example/a"],
    };
    const fake: Source = {
      name: "fake",
      kind: "search",
      cost: "free",
      search: async (q) => (answers[q.terms] ?? []).map((url) => ({ url, title: url })),
    };
    const d = { ...deps(), sources: registry(fake, opener) };
    const planned = await planRound(d, {
      ask: { text: "what does a tree find", kind: "web" },
      planFile,
      model: "m",
    });
    const runId = planned.run;
    const tree = {
      facets: [
        {
          name: "number",
          why: "a figure",
          tries: [[{ terms: "n1", why: "w" }], [{ terms: "n2", why: "w" }]],
        },
        { name: "how", why: "a method", tries: [[{ terms: "h1", why: "w" }]] },
        {
          name: "counter",
          why: "the case against",
          tries: [[{ terms: "c1", why: "w" }], [{ terms: "c2", why: "w" }]],
        },
      ],
    };
    // Tier 1: every facet's first try, one fetch.
    const one = await searchTree(d, runId, tree, agent);
    expect(one.ok).toBe(true);
    expect(one.wrote.filter((r) => r.type === "done")).toHaveLength(1);
    expect(one.tree.facets.map((f) => [f.name, f.tries.length, f.hits, f.uncalled])).toEqual([
      ["number", 1, 2, 2],
      ["how", 1, 3, 4],
      ["counter", 1, 0, 0],
    ]);
    expect(one.tree.uncovered).toEqual(["who", "primary"]);
    // Again before triage: number and how wait on their calls; counter had nothing to call and
    // falls through to its second try, which finds page a again: a found, no new hit.
    const two = await searchTree(d, runId, tree, agent);
    expect(two.ok).toBe(true);
    expect(two.note).toContain("number: 2 uncalled, triage first");
    expect(two.note).toContain("counter: try 2 (0 kept)");
    expect(two.wrote.filter((r) => r.type === "found")).toHaveLength(1);
    expect(two.wrote.filter((r) => r.type === "hit")).toHaveLength(0);
    // Triage: how keeps three (enough), number keeps one (thin), counter's one hit is page a.
    const hits = (await brief(d, runId)).hits.uncalled;
    expect(hits[0]).toMatchObject({
      url: "https://x.example/a",
      facets: ["counter", "how", "number"],
    });
    const idOf = (url: string) => hits.find((h) => h.url === url)?.id as string;
    for (const [url, verdict] of [
      ["https://x.example/a", "keep"],
      ["https://x.example/b", "drop"],
      ["https://x.example/f", "keep"],
      ["https://x.example/g", "keep"],
      ["https://x.example/h", "drop"],
    ] as const)
      await add(d, runId, { type: "call", on: idOf(url), verdict, why: "t" }, agent);
    // Tier 2 of number only; how is enough; counter is thin and out of tries: a gap.
    const three = await searchTree(d, runId, tree, agent);
    expect(three.ok).toBe(true);
    expect(three.note).toContain("number: try 2 (1 kept)");
    expect(three.note).toContain("how: 3 kept, enough");
    expect(three.wrote.map((r) => r.type === "gap" && r.note).filter(Boolean)).toEqual([
      'facet "counter": 1 kept in 2 tries, none left',
    ]);
    expect(
      three.tree.facets.map((f) => [f.name, f.tries.length, f.hits, f.kept, f.enough]),
    ).toEqual([
      ["number", 2, 5, 1, false],
      ["how", 1, 3, 3, true],
      ["counter", 2, 0, 1, false],
    ]);
    // --all with nothing left: number's gap once, counter's not again, how enough; exit as gave up.
    const none = await searchTree(d, runId, tree, agent, { all: true });
    expect(none.ok).toBe(false);
    expect(none.note).toContain("nothing to search");
    expect(none.wrote.map((r) => r.type === "gap" && r.note).filter(Boolean)).toEqual([
      'facet "number": 1 kept in 2 tries, none left',
    ]);
    const b = await brief(d, runId);
    expect(b.hits.total).toBe(8);
    expect(b.hits.uncalled.map((h) => h.url)).toEqual([
      "https://x.example/c",
      "https://x.example/d",
      "https://x.example/e",
    ]);
    expect(b.gaps).toHaveLength(2);
  });

  it("learns: the next plan file version carries the changes, and nothing else moves", () => {
    const next = tunePlan(planFile, {
      sources: ["fake"],
      budget: { rounds: 4 },
      age: "Age counts.",
    });
    expect(next.version).toBe(planFile.version + 1);
    expect(next.sources).toEqual(["fake"]);
    expect(next.budget).toEqual({ ...planFile.budget, rounds: 4 });
    expect(next.age).toBe("Age counts.");
    expect(next.propose).toBe(planFile.propose);
    expect(() => tunePlan(planFile, { budget: {} })).toThrow("nothing changed");
    expect(() => tunePlan(planFile, { budget: { rounds: 0 } })).toThrow();
  });

  it("every step needs the round's plan", async () => {
    const d = deps();
    await expect(search(d, "nope", [{ terms: "a", why: "w" }], agent)).rejects.toThrow(
      "no records",
    );
    await expect(planRound(d, { planFile, model: null })).rejects.toThrow("needs an ask");
    await expect(
      planRound(d, {
        ask: { text: "x", kind: "web" },
        planFile: { ...planFile, sources: ["exa"] },
        model: null,
      }),
    ).rejects.toThrow("no source named exa");
  });
});
