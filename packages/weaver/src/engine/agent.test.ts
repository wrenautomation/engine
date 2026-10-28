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
import { recall } from "./recall.js";
import { run } from "./runner.js";
import { checkCount, classesOf, echoOf, fold, type RunState, sourcesOf } from "./state.js";

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

    // A class on a document reaches its findings; one on a finding overrides it; the latest wins.
    const weekly = findings[1];
    if (weekly?.type !== "finding") throw new Error("no second finding");
    const classes = async () => (await brief(d, runId)).patterns.at(-1)?.classes;
    expect(await classes()).toEqual({ unclassed: 2 });
    expect((await brief(d, runId)).documents.unclassed.map((x) => x.id)).toEqual([
      docOne.id,
      weekly.document,
    ]);
    await add(d, runId, { type: "class", on: docOne.id, class: "survey", why: "a survey" }, agent);
    await add(d, runId, { type: "class", on: weekly.document, class: "vendor", why: "ad" }, agent);
    expect(await classes()).toEqual({ survey: 1, vendor: 1 });
    await add(d, runId, { type: "class", on: weekly.id, class: "survey", why: "cites one" }, agent);
    expect(await classes()).toEqual({ survey: 2 });
    await add(d, runId, { type: "class", on: docOne.id, class: "forum", why: "a thread" }, agent);
    expect(await classes()).toEqual({ forum: 1, survey: 1 });
    expect((await brief(d, runId)).documents.unclassed).toEqual([]);
    // Vendor echo: every classed source a vendor, flagged in brief and warned on a new pattern.
    await add(d, runId, { type: "class", on: docOne.id, class: "vendor", why: "sells it" }, agent);
    await add(d, runId, { type: "class", on: weekly.id, class: "vendor", why: "sells it" }, agent);
    expect((await brief(d, runId)).patterns.at(-1)).toMatchObject({
      classes: { vendor: 2 },
      sources: 2,
      echo: true,
    });
    const echo = await add(
      d,
      runId,
      { type: "pattern", text: "Vendors agree.", findings: keptIds },
      agent,
    );
    expect(echo.warnings).toContain(
      "vendor echo: every classed source is a vendor; vendors cite each other",
    );
    expect((await check(d, runId, { patterns: true })).note).toBe("nothing to check");
    await expect(
      add(d, runId, { type: "class", on: "nope", class: "news", why: "x" }, agent),
    ).rejects.toThrow("no document or finding nope");

    // A rough draft: each item cites kept findings or patterns, and its numbers come from them.
    const draft = await add(
      d,
      runId,
      {
        type: "draft",
        for: "a decision memo",
        items: [
          {
            title: "Repeat work",
            body: "38% of placements came from repeat clients.",
            cites: [pattern.record.id],
          },
          { title: "Ads", body: "Ads bring 60% of placements.", cites: [keptIds[1] ?? ""] },
          { title: "Ghost", body: "Something.", cites: ["nope"] },
        ],
      },
      agent,
    );
    if (draft.record.type !== "draft") throw new Error("no draft");
    expect(draft.record.items).toEqual([
      {
        title: "Repeat work",
        body: "38% of placements came from repeat clients.",
        cites: [pattern.record.id],
      },
    ]);
    expect(draft.record.dropped).toEqual([
      { title: "Ads", why: "number_not_cited" },
      { title: "Ghost", why: "unknown_cite" },
    ]);
    expect(draft.warnings).toHaveLength(2);
    expect((await brief(d, runId)).draft?.id).toBe(draft.record.id);
    await expect(
      add(d, runId, { type: "draft", for: "x", items: [{ body: "x", cites: [] }] }, agent),
    ).rejects.toThrow("every item failed the gate (no_cites)");

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
      ["Vendors agree.", 2],
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

  it("counts forum threads, not the forum's site; checks at least a tenth; a facet flags the class it lacks", () => {
    const f = (id: string, document: string, url: string) => ({
      id,
      document,
      round: 1,
      proof: { url, quote: "five words of a quote" },
    });
    const state = {
      findings: [
        f("f1", "d1", "https://reddit.com/r/hvac/comments/1"),
        f("f2", "d2", "https://reddit.com/r/hvac/comments/2"),
        f("f3", "d3", "https://vendor.example/a"),
        f("f4", "d4", "https://vendor.example/b"),
      ],
      called: new Map(),
      classOf: new Map([
        ["d1", "forum"],
        ["d2", "forum"],
        ["d3", "vendor"],
        ["d4", "vendor"],
      ]),
    } as unknown as RunState;
    const forum = classesOf(state, ["f1", "f2"]);
    expect(forum).toEqual({ forum: 2 });
    expect(sourcesOf(forum)).toBe(2);
    expect(echoOf(forum)).toBe(false);
    const vendors = classesOf(state, ["f3", "f4"]);
    expect(vendors).toEqual({ vendor: 1 });
    expect(echoOf(vendors)).toBe(true);
    expect(echoOf(classesOf(state, ["f1", "f3"]))).toBe(false);
    expect(checkCount(700, 3)).toBe(70);
    expect(checkCount(10, 3)).toBe(3);
    expect(checkCount(700, 0)).toBe(0);
  });

  it("a facet names the classes it needs; a try pinned to one site is flagged", async () => {
    const fake: Source = {
      name: "fake",
      kind: "search",
      cost: "free",
      search: async (q) => [{ url: `https://x.example/${q.terms}`, title: q.terms }],
    };
    const d = { ...deps(), sources: registry(fake, opener) };
    const runId = (
      await planRound(d, {
        ask: { text: "what do owners spend", kind: "web" },
        planFile,
        model: "m",
      })
    ).run;
    const facet = (needs: string[]) => ({
      facets: [
        {
          name: "spend",
          why: "what they pay",
          needs,
          tries: [[{ terms: "s1", site: "reddit.com", why: "w" }]],
        },
      ],
    });
    await expect(searchTree(d, runId, facet(["blog"]), agent)).rejects.toThrow(
      'facet "spend" needs blog',
    );
    const one = await searchTree(d, runId, facet(["survey", "primary_data"]), agent);
    expect(one.note).toContain("spend: every try pins reddit.com");
    expect(one.tree.facets[0]).toMatchObject({
      needs: ["survey", "primary_data"],
      classes: {},
      lacks: false,
    });
  });

  it("a site's own reader opens its URLs before the general openers, whatever the list's order", async () => {
    const asked: string[] = [];
    const general: Source = {
      ...opener,
      open: (h) => {
        asked.push(`opener ${h.url}`);
        return (opener.open as NonNullable<Source["open"]>)(h);
      },
    };
    const site: Source = {
      ...opener,
      name: "site",
      first: true,
      opens: (url) => url.startsWith("https://b.example/"),
      open: (h) => {
        asked.push(`site ${h.url}`);
        return (opener.open as NonNullable<Source["open"]>)(h);
      },
    };
    const d = { ...deps(), sources: registry(fake, general, site) };
    const { run } = await planRound(d, {
      ask: { text: "how do staffing firms win repeat clients", kind: "web" },
      planFile: { ...planFile, sources: ["fake", "opener", "site"] },
      model: "m",
    });
    await open(
      d,
      run,
      { urls: ["https://b.example/four", "https://a.example/one"], why: "order" },
      agent,
    );
    expect(asked.sort()).toEqual(["opener https://a.example/one", "site https://b.example/four"]);
  });

  it("a site-scoped query skips a searcher that cannot keep to the site", async () => {
    const asked: string[] = [];
    const tube: Source = {
      name: "tube",
      kind: "search",
      cost: "free",
      keeps: (site) => site === "youtube.com",
      search: async (q) => {
        asked.push(`tube ${q.terms}`);
        return [];
      },
    };
    const web: Source = {
      ...fake,
      search: async (q) => {
        asked.push(`web ${q.terms}`);
        return [];
      },
    };
    const d = { ...deps(), sources: registry(web, tube, opener) };
    const { run } = await planRound(d, {
      ask: { text: "how do staffing firms win repeat clients", kind: "web" },
      planFile: { ...planFile, sources: ["fake", "tube", "opener"] },
      model: "m",
    });
    await search(
      d,
      run,
      [
        { terms: "on reddit", why: "threads", site: "reddit.com" },
        { terms: "on youtube", why: "talks", site: "youtube.com" },
        { terms: "anywhere", why: "all" },
      ],
      agent,
    );
    expect(asked.sort()).toEqual([
      "tube anywhere",
      "tube on youtube",
      "web anywhere",
      "web on reddit",
      "web on youtube",
    ]);
    // Every searcher it went to answered empty: still a gap.
    const gaps = (await d.ledger.trace(run)).filter((r) => r.type === "gap");
    expect(gaps).toHaveLength(3);
  });

  it("tests what the ask takes as given: a known line with no source is a premise", async () => {
    const d = deps();
    const { run } = await planRound(d, {
      ask: {
        text: "who buys growth help",
        kind: "web",
        known: ["Coaches buy growth help", "Setters cost $2k (https://a.example/one)"],
        premises: ["The offer is a revenue share"],
      },
      planFile,
      model: "m",
    });
    const b = await brief(d, run);
    expect(b.ask?.known).toEqual(["Setters cost $2k (https://a.example/one)"]);
    expect(b.ask?.premises).toEqual(["The offer is a revenue share", "Coaches buy growth help"]);
    const tree = (facets: string[]) => ({
      facets: facets.map((name) => ({ name, why: "w", tries: [[{ terms: name, why: "w" }]] })),
    });
    const untested = await searchTree(d, run, tree(["number"]), agent);
    expect(untested.tree.uncovered).toContain("premise");
    const tested = await searchTree(d, run, tree(["how", "premise"]), agent);
    expect(tested.tree.uncovered).not.toContain("premise");
  });

  it("a tree of runs: a child links to its parent, and a stopped child's patterns and dead ends reach the parent's next plan", async () => {
    const d = deps();
    const runs = { depth: 2, children: 2 };
    const pf = { ...planFile, budget: { ...planFile.budget, rounds: 2 }, runs };
    const { run: root } = await planRound(d, {
      ask: { text: "which niche buys repeat work", kind: "web" },
      planFile: pf,
      model: "m",
    });
    await open(d, root, { urls: ["https://a.example/one"], why: "wide" }, agent);
    await extract(d, root);
    const child = async (text: string, why = "a niche", parent = root) =>
      (
        await planRound(d, {
          ask: { text, kind: "web" },
          planFile: { ...planFile, budget: { ...planFile.budget, reads: 9 }, runs },
          model: "m",
          parent: { run: parent, why },
        })
      ).run;

    // A child reads what its parent found, and never gets more budget than its parent.
    const a = await child("repeat clients placements");
    const ba = await brief(d, a);
    expect(ba.parent).toEqual({ run: root, round: 1, why: "a niche" });
    expect(ba.budget?.reads).toBe(1);
    expect(ba.ask?.known).toContain(
      "38% of placements came from repeat clients. (https://a.example/one)",
    );

    // The child goes deep, gives up on a facet, and stops.
    await open(d, a, { urls: ["https://b.example/four"], why: "deep" }, agent);
    await extract(d, a);
    const [f] = (await brief(d, a)).findings.kept;
    if (!f) throw new Error("the child kept nothing");
    const p = await add(
      d,
      a,
      { type: "pattern", text: "Weekly calls keep clients.", findings: [f.id] },
      agent,
    );
    await add(d, a, { type: "dead", facet: "spend", why: "consumers, not buyers" }, agent);
    await expect(add(d, a, { type: "dead", facet: "spend", why: "again" }, agent)).rejects.toThrow(
      "dead already",
    );
    const skipped = await searchTree(
      d,
      a,
      { facets: [{ name: "spend", why: "w", tries: [[{ terms: "a", why: "w" }]] }] },
      agent,
    );
    expect(skipped.note).toContain("spend: dead");
    expect(skipped.tree.dead).toEqual(["spend"]);
    await add(d, a, { type: "edge", next: "stop", why: "one niche checked" }, agent);

    // The caps: children per parent round, and depth.
    const b = await child("coaches", "a second niche");
    await expect(child("third")).rejects.toThrow("the cap");
    await expect(child("deeper", "go deeper", a)).rejects.toThrow("the tree stops at 2");
    await expect(child("no why", " ")).rejects.toThrow("why this child");

    const rb = await brief(d, root);
    expect(rb.children.map((c) => [c.run, c.stopped, c.patterns])).toEqual([
      [a, true, 1],
      [b, false, 0],
    ]);
    expect(rb.treeCost).not.toBeNull();

    // The parent's next plan: the stopped child as known lines, the running one as open.
    await add(d, root, { type: "edge", next: "again", why: "go deep per niche" }, agent);
    const next = await planRound(d, { run: root, planFile: pf, model: "m" });
    const snap = next.wrote[0];
    if (snap?.type !== "snapshot") throw new Error("no snapshot");
    expect(snap.ask.known).toEqual(
      expect.arrayContaining([
        `child run ${a} ("repeat clients placements") stopped: one niche checked`,
        `Weekly calls keep clients. (run ${a}, pattern ${p.record.id}; sources: unclassed 1)`,
        `dead end, skip it: spend: consumers, not buyers (run ${a})`,
      ]),
    );
    expect(snap.ask.open).toContain(`child run ${b} ("coaches") has not stopped`);
    expect(snap.ask.premises).toEqual([]);

    // The runner links a child the same way.
    await run(
      { ...d, model: null },
      {
        run: "by-runner",
        ask: { text: "staffing repeat clients", kind: "web" },
        planFile: { ...planFile, runs },
        parent: { run: root, why: "the runner's niche" },
        steps: 1,
      },
    );
    const byRunner = fold("by-runner", await d.ledger.trace("by-runner")).snapshot;
    expect(byRunner?.parent).toEqual({ run: root, round: 2, why: "the runner's niche" });
    expect(byRunner?.ask.known).toContain(
      "38% of placements came from repeat clients. (https://a.example/one)",
    );
  });

  it("recalls what earlier runs found: quote, date and run, dropped ones left out", async () => {
    const d = deps();
    const runOf = async (text: string) => {
      const { run } = await planRound(d, {
        ask: { text, kind: "web" },
        planFile,
        model: "m",
      });
      const did = await open(d, run, { urls: ["https://a.example/one"], why: "read" }, agent);
      const doc = (await d.ledger.trace(run)).find((r) => r.type === "document");
      if (!doc) throw new Error(`no document: ${JSON.stringify(did)}`);
      return { run, doc: doc.id };
    };
    const first = await runOf("how do staffing firms win repeat clients");
    const kept = await add(
      d,
      first.run,
      {
        type: "finding",
        document: first.doc,
        text: "38% of placements came from repeat clients.",
        quote: "38% of placements came from repeat clients",
      },
      agent,
    );
    const dropped = await add(
      d,
      first.run,
      {
        type: "finding",
        document: first.doc,
        text: "A survey covered 412 firms.",
        quote: "A 2025 survey of 412 firms",
      },
      agent,
    );
    await add(
      d,
      first.run,
      { type: "call", on: kept.record.id, verdict: "keep", why: "a number" },
      agent,
    );
    await add(
      d,
      first.run,
      { type: "call", on: dropped.record.id, verdict: "drop", why: "thin" },
      agent,
    );
    const second = await runOf("where do placements come from");
    await add(
      d,
      second.run,
      {
        type: "finding",
        document: second.doc,
        text: "Repeat clients gave 38% of placements.",
        quote: "38% of placements came from repeat clients",
      },
      agent,
    );
    const found = await recall(d.ledger, "repeat clients placements");
    // One page, one quote: the latest run's, with the earlier run beside it.
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      run: second.run,
      ask: "where do placements come from",
      quote: "38% of placements came from repeat clients",
      url: "https://a.example/one",
      by: agent.by,
      state: "open",
      alsoIn: [first.run],
    });
    expect(await recall(d.ledger, "412 firms survey")).toEqual([]);
    const notSecond = await recall(d.ledger, "repeat clients", { not: second.run });
    expect(notSecond.map((r) => [r.run, r.state])).toEqual([[first.run, "kept"]]);
    await expect(recall(d.ledger, "  ")).rejects.toThrow("recall needs terms");
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
