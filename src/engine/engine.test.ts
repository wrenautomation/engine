import { claimExtractor } from "@wrenautomation/falcon/document";
import { defaultPlanFile, type Model, scriptedModel } from "@wrenautomation/raven";
import { describe, expect, it } from "vitest";
import { countingIds } from "../ledger/ids.js";
import { MemoryLedger } from "../ledger/memory.js";
import { canonical } from "./canonical.js";
import { type Deps, pick, registry, type Source } from "./ports.js";
import { run } from "./runner.js";
import { fold } from "./state.js";
import { Transient } from "./transient.js";

const pages: Record<string, string> = {
  "https://a.example/one":
    "A 2025 survey of 412 firms found 38% of placements came from repeat clients.",
  "https://a.example/two": "Nothing here.",
  "https://a.example/three": "Firms said referrals were cheaper than ads by a wide margin.",
  "https://b.example/four": "The speaker says a weekly call keeps a client for 3 more years.",
};

const results: Record<string, string[]> = {
  a: ["https://a.example/one", "https://a.example/two"],
  b: ["https://a.example/two/?utm_source=x", "https://a.example/three"],
  c: ["https://a.example/three#top", "https://b.example/four"],
};

const fake: Source = {
  name: "fake",
  kind: "search",
  cost: "free",
  search: async (q) => (results[q.terms] ?? []).map((url) => ({ url, title: url })),
};
const opener = (fail: Set<string> = new Set()): Source => ({
  name: "opener",
  kind: "open",
  cost: "free",
  open: async (h) => {
    if (fail.has(h.url)) throw new Error("boom");
    const text = pages[h.url];
    return text ? { url: h.url, media: "text", text } : null;
  },
});

const planFile = {
  ...defaultPlanFile("web"),
  sources: ["fake", "opener"],
  budget: { queries: 4, reads: 3, rounds: 3 },
};

const answers = {
  plan1: {
    queries: [
      { terms: "a", why: "w" },
      { terms: "b", why: "w" },
    ],
  },
  triage1: {
    hits: [
      { url: "https://a.example/one", read: true, why: "y" },
      { url: "https://a.example/three", read: true, why: "y" },
    ],
  },
  extractOne: {
    findings: [
      {
        text: "38% of placements came from repeat clients.",
        quote: "38% of placements came from repeat clients",
      },
      { text: "Half came from ads.", quote: "not on the page at all" },
    ],
  },
  extractThree: { findings: [] },
  again: { next: "again", why: "thin" },
  plan2: { queries: [{ terms: "c", why: "w" }] },
  triage2: { hits: [{ url: "https://b.example/four", read: true, why: "y" }] },
  extractFour: {
    findings: [
      {
        text: "A weekly call keeps a client 3 more years, the speaker says.",
        quote: "a weekly call keeps a client for 3 more years",
      },
    ],
  },
  stop: { next: "stop", why: "enough" },
};

const deps = (model: Model | null, open = opener()): Deps => {
  let t = 0;
  return {
    sources: registry(fake, open),
    ledger: new MemoryLedger(),
    model,
    extractor: claimExtractor,
    clock: () => new Date(Date.UTC(2026, 9, 27, 10, 0, ++t)),
    ids: countingIds(),
    runner: "weaver",
  };
};

describe("canonical", () => {
  it("drops tracking, fragments and trailing slashes; folds YouTube forms", () => {
    expect(canonical("https://A.example/p/?utm_source=x&b=2&a=1#top")).toBe(
      "https://a.example/p?a=1&b=2",
    );
    expect(canonical("https://youtu.be/dQw4w9WgXcQ?si=abc")).toBe(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    );
    expect(canonical("https://m.youtube.com/shorts/dQw4w9WgXcQ")).toBe(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    );
    expect(canonical("not a url")).toBe("not a url");
  });
});

describe("registry", () => {
  it("picks the allow-list in order and names a missing source", () => {
    const r = registry(fake, opener());
    expect(pick(r, ["opener", "fake"]).map((s) => s.name)).toEqual(["opener", "fake"]);
    expect(() => pick(r, ["fake", "exa"])).toThrow("no source named exa");
  });
});

describe("runner", () => {
  it("runs two rounds, dedupes hits across rounds, grounds findings, writes every spend", async () => {
    const a = answers;
    const model = scriptedModel(
      [
        a.plan1,
        a.triage1,
        a.extractOne,
        a.extractThree,
        a.again,
        a.plan2,
        a.triage2,
        a.extractFour,
        a.stop,
      ],
      "m",
    );
    const d = deps(model);
    const steps: string[] = [];
    const out = await run(d, {
      ask: { text: "repeat clients", kind: "web" },
      planFile,
      onStep: (e) => steps.push(`${e.round}:${e.step}:${e.ok ? "ok" : "no"}`),
    });
    expect(out.finished).toBe(true);
    expect(out.rounds).toBe(2);
    expect(out.note).toBe("enough");
    expect(steps).toEqual([
      "1:plan:ok",
      "1:fetch:ok",
      "1:triage:ok",
      "1:read:ok",
      "1:extract:ok",
      "1:review:ok",
      "2:plan:ok",
      "2:fetch:ok",
      "2:triage:ok",
      "2:read:ok",
      "2:extract:ok",
      "2:review:ok",
    ]);
    const s = out.state;
    expect(s.hits.map((h) => h.key)).toEqual([
      "https://a.example/one",
      "https://a.example/two",
      "https://a.example/three",
      "https://b.example/four",
    ]);
    expect(s.hits[1]?.sources).toEqual(["fake"]);
    expect(s.hits[1]?.queries).toHaveLength(1);
    expect(s.documents.map((x) => x.url)).toEqual([
      "https://a.example/one",
      "https://a.example/three",
      "https://b.example/four",
    ]);
    expect(s.findings.map((f) => f.proof.quote)).toEqual([
      "38% of placements came from repeat clients",
      "a weekly call keeps a client for 3 more years",
    ]);
    expect(s.findings[0]).toMatchObject({ from: "ai", by: "m", step: "extract", round: 1 });
    expect(s.spends.filter((x) => x.op === "search")).toHaveLength(3);
    expect(s.spends.filter((x) => x.op === "open")).toHaveLength(3);
    expect(s.spends.filter((x) => x.op === "ask").map((x) => x.on ?? "-")).toEqual([
      "-",
      "-",
      s.documents[0]?.id,
      s.documents[1]?.id,
      "-",
      "-",
      "-",
      s.documents[2]?.id,
      "-",
    ]);
    expect(s.verdicts.map((v) => [v.document, v.quality])).toEqual([
      [s.documents[0]?.id, "thin"],
      [s.documents[1]?.id, "off"],
      [s.documents[2]?.id, "thin"],
    ]);
    expect(s.verdicts[0]).toMatchObject({ from: "ai", by: "m", step: "extract", round: 1 });
    expect(s.snapshot?.known).toEqual(["38% of placements came from repeat clients."]);
    expect(s.edges.map((e) => e.next)).toEqual(["again", "stop"]);
    const rows = await d.ledger.yield({ source: "fake" });
    expect(rows[0]).toEqual({ source: "fake", hits: 4, reads: 3, proposed: 2, kept: 2 });
    const again = await run(d, { resume: out.run });
    expect(again.state.records.length).toBe(s.records.length);
  });

  it("stops on a step that gives up and resumes from it", async () => {
    const a = answers;
    const fail = new Set(["https://a.example/one"]);
    const open = opener(fail);
    const d = deps(scriptedModel([a.plan1, a.triage1, a.extractThree, a.stop], "m"), open);
    const first = await run(d, {
      ask: { text: "repeat clients", kind: "web" },
      planFile: { ...planFile, sources: ["fake"] },
    });
    expect(first.finished).toBe(false);
    expect(first.note).toBe("no open source in the allow-list");
    expect(first.state.next).toEqual({ round: 1, step: "read" });
    const broken = d.ledger.scan({ type: "done" }).then((r) => r.at(-1));
    expect((await broken)?.type).toBe("done");
    const second = await run(
      { ...d, sources: registry(fake, open) },
      { resume: first.run, planFile },
    );
    expect(second.state.next).toEqual({ round: 1, step: "read" });
  });

  it("tries a transient search again, every attempt on record", async () => {
    const a = answers;
    const slept: number[] = [];
    let flaky = 0;
    const once: Source = {
      ...fake,
      name: "flaky",
      search: async (q) => {
        if (q.terms === "a" && flaky++ === 0)
          throw new Transient("flaky: HTTP 429", { retryAfter: "2026-10-27T10:05:00.000Z" });
        return (results[q.terms] ?? []).map((url) => ({ url, title: url }));
      },
    };
    const model = scriptedModel([a.plan1, a.triage1, a.extractOne, a.extractThree, a.stop], "m");
    const d = {
      ...deps(model),
      sources: registry(once, opener()),
      sleep: async (ms: number) => void slept.push(ms),
    };
    const out = await run(d, {
      ask: { text: "repeat clients", kind: "web" },
      planFile: { ...planFile, sources: ["flaky", "opener"] },
    });
    expect(out.finished).toBe(true);
    const searches = out.state.spends.filter((x) => x.op === "search");
    expect(searches.map((x) => [x.ok, x.retryAfter ?? null])).toEqual([
      [false, "2026-10-27T10:05:00.000Z"],
      [true, null],
      [true, null],
    ]);
    expect(searches[0]?.error).toBe("flaky: HTTP 429");
    expect(slept).toEqual([60_000]);
    expect(out.state.hits).toHaveLength(3);
  });

  it("on a resume skips a search whose ok spend is on record", async () => {
    const a = answers;
    const searched: string[] = [];
    const counting: Source = {
      ...fake,
      search: async (q) => {
        searched.push(q.terms);
        return (results[q.terms] ?? []).map((url) => ({ url, title: url }));
      },
    };
    const d = { ...deps(scriptedModel([a.plan1], "m")), sources: registry(counting, opener()) };
    const first = await run(d, {
      ask: { text: "x", kind: "web" },
      planFile,
      run: "r0",
      steps: 1,
    });
    expect(first.state.next).toEqual({ round: 1, step: "fetch" });
    const qa = first.state.queries.find((q) => q.terms === "a");
    // As if the process died after the first search: its spend is on record, no done.
    await d.ledger.append({
      type: "spend",
      id: "spend-a",
      run: "r0",
      round: 1,
      step: "fetch",
      at: d.clock().toISOString(),
      from: "tool",
      by: "weaver",
      source: "fake",
      op: "search",
      about: "a",
      on: qa?.id ?? "",
      ok: true,
      cost: "free",
      ms: 1,
    });
    const second = await run(
      // Query a's hits are not on record, so only "three" is read.
      { ...d, model: scriptedModel([a.triage1, a.extractThree, a.stop], "m") },
      { resume: "r0", planFile },
    );
    expect(searched).toEqual(["b"]);
    expect(second.state.hits.map((h) => h.key)).toEqual([
      "https://a.example/two",
      "https://a.example/three",
    ]);
    expect(second.finished).toBe(true);
    expect(second.state.spends.filter((x) => x.op === "search")).toHaveLength(2);
  });

  it("keeps what an extract batch wrote when one document's extract fails for good", async () => {
    const a = answers;
    const broken: typeof claimExtractor = {
      ...claimExtractor,
      extract: (doc, ...rest) => {
        if (doc.url.endsWith("/three")) throw new Error("boom");
        return claimExtractor.extract(doc, ...rest);
      },
    };
    const d = {
      ...deps(scriptedModel([a.plan1, a.triage1, a.extractOne], "m")),
      extractor: broken,
    };
    const first = await run(d, { ask: { text: "repeat clients", kind: "web" }, planFile });
    expect(first.finished).toBe(false);
    expect(first.note).toBe("boom");
    expect(first.state.next).toEqual({ round: 1, step: "extract" });
    expect(first.state.findings.map((f) => f.text)).toEqual([
      "38% of placements came from repeat clients.",
    ]);
    expect(first.state.verdicts).toHaveLength(1);
    const second = await run(
      { ...d, extractor: claimExtractor, model: scriptedModel([a.extractThree, a.stop], "m") },
      { resume: first.run, planFile },
    );
    expect(second.finished).toBe(true);
    expect(second.state.verdicts.map((v) => v.document)).toHaveLength(2);
    expect(second.state.findings).toHaveLength(1);
  });

  it("lets a Transient through when a step got nothing, with no done, so a resume runs the step again", async () => {
    const a = answers;
    let calls = 0;
    const down: Source = {
      ...fake,
      name: "down",
      search: async () => {
        calls++;
        throw new Transient("down: HTTP 503");
      },
    };
    const d = {
      ...deps(scriptedModel([a.plan1], "m")),
      sources: registry(down, opener()),
      sleep: async () => {},
    };
    const err = await run(d, {
      ask: { text: "x", kind: "web" },
      planFile: { ...planFile, sources: ["down", "opener"] },
      run: "r1",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Transient);
    expect(calls).toBe(6);
    const trace = await d.ledger.trace("r1");
    expect(trace.filter((r) => r.type === "done").map((r) => r.step)).toEqual(["plan"]);
    expect(trace.filter((r) => r.type === "spend" && !r.ok)).toHaveLength(6);
    const state = fold("r1", trace);
    expect(state.next).toEqual({ round: 1, step: "fetch" });
    // The spends of the failed try stay; the resume searches both queries again.
    const up = { ...d, sources: registry({ ...fake, name: "down" }, opener()) };
    const again = await run(
      { ...up, model: scriptedModel([a.triage1, a.extractOne, a.extractThree, a.stop], "m") },
      { resume: "r1", planFile: { ...planFile, sources: ["down", "opener"] } },
    );
    expect(again.finished).toBe(true);
    expect(again.state.spends.filter((x) => x.op === "search" && x.ok)).toHaveLength(2);
  });

  it("gives the review each document's verdict", async () => {
    const a = answers;
    const prompts: string[] = [];
    const inner = scriptedModel([a.plan1, a.triage1, a.extractOne, a.extractThree, a.stop], "m");
    const model: Model = {
      id: "m",
      ask: (prompt, shape) => {
        prompts.push(prompt);
        return inner.ask(prompt, shape);
      },
    };
    const out = await run(deps(model), { ask: { text: "repeat clients", kind: "web" }, planFile });
    expect(out.finished).toBe(true);
    const review = prompts.at(-1) ?? "";
    expect(review).toContain("https://a.example/one");
    expect(review).toContain("thin");
    expect(review).toContain("https://a.example/three");
    expect(review).toContain("off");
  });

  it("without a model reads in order up to the budget and stops after one round", async () => {
    const d = deps(null);
    const out = await run(d, {
      ask: { text: "x", kind: "web" },
      planFile,
      proposals: [
        {
          from: "human",
          by: "will",
          queries: [
            { kind: "web", terms: "a", why: "mine" },
            { kind: "web", terms: "b", why: "mine" },
          ],
        },
      ],
    });
    expect(out.finished).toBe(false);
    expect(out.note).toBe("no model: nothing extracted");
    expect(out.state.documents).toHaveLength(3);
    expect(out.state.calls.map((c) => c.verdict)).toEqual(["keep", "keep", "keep"]);
    expect(out.state.queries.map((q) => q.from)).toEqual(["human", "human"]);
  });
});
