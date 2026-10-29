import { fakeModel, type Model, Transient } from "@wrenautomation/models";
import { describe, expect, it } from "vitest";
import { allowList } from "../app/engine-cli.js";
import { Cut, claimExtractor } from "../document/index.js";
import { countingIds } from "../ledger/ids.js";
import { MemoryLedger } from "../ledger/memory.js";
import { extract, open, planRound, search, type Who } from "./agent.js";
import { canonical } from "./canonical.js";
import { defaultPlanFile } from "./plan.js";
import { type Deps, pick, registry, type Source } from "./ports.js";
import { fold } from "./state.js";

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
    if (!text) throw new Error("not on file");
    return { url: h.url, media: "text", text };
  },
});

/** An opener that claims only YouTube pages: never asked for the test's pages, so no spend. */
const video: Source = {
  name: "video",
  kind: "open",
  cost: "metered",
  opens: (url) => url.includes("youtube.com"),
  open: async () => {
    throw new Error("video: never called");
  },
};

const planFile = {
  ...defaultPlanFile("web"),
  sources: ["fake", "video", "opener"],
  budget: { queries: 4, reads: 3, rounds: 3, checks: 0 },
};

const extractOne = {
  findings: [
    {
      text: "38% of placements came from repeat clients.",
      quote: "38% of placements came from repeat clients",
    },
  ],
};

/** Answers by the page in the prompt; `cut` may throw first for a prompt. */
const byPage = (cut?: (p: string) => void) =>
  fakeModel((prompt) => {
    cut?.(prompt);
    return JSON.stringify(prompt.includes("412 firms") ? extractOne : { findings: [] });
  }, "m");

const deps = (model: Model | null, open = opener()): Deps => {
  let t = 0;
  return {
    sources: registry(fake, video, open),
    ledger: new MemoryLedger(),
    model,
    extractor: claimExtractor,
    clock: () => new Date(Date.UTC(2026, 9, 27, 10, 0, ++t)),
    ids: countingIds(),
    writer: "birdwatch",
  };
};
const agent: Who = { from: "ai", by: "claude-code" };

/** A planned run with pages one and three open. */
async function opened(d: Deps): Promise<string> {
  const { run } = await planRound(d, {
    ask: { text: "repeat clients", kind: "web" },
    planFile,
    model: "m",
  });
  await open(
    d,
    run,
    { urls: ["https://a.example/one", "https://a.example/three"], why: "w" },
    agent,
  );
  return run;
}

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

describe("steps", () => {
  it("tries a transient search again, every attempt on record", async () => {
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
    const d = {
      ...deps(null),
      sources: registry(once, opener()),
      sleep: async (ms: number) => void slept.push(ms),
    };
    const { run } = await planRound(d, {
      ask: { text: "repeat clients", kind: "web" },
      planFile: { ...planFile, sources: ["flaky", "opener"] },
      model: null,
    });
    await search(
      d,
      run,
      [
        { terms: "a", why: "w" },
        { terms: "b", why: "w" },
      ],
      agent,
    );
    const state = fold(run, await d.ledger.trace(run));
    const searches = state.spends.filter((x) => x.op === "search");
    expect(searches.map((x) => [x.ok, x.retryAfter ?? null])).toEqual([
      [false, "2026-10-27T10:05:00.000Z"],
      [true, null],
      [true, null],
    ]);
    expect(searches[0]?.error).toBe("flaky: HTTP 429");
    expect(slept).toEqual([60_000]);
    expect(state.hits).toHaveLength(3);
  });

  it("lets a Transient through when a search got nothing, with no done, so the step runs again", async () => {
    let calls = 0;
    const down: Source = {
      ...fake,
      name: "down",
      search: async () => {
        calls++;
        throw new Transient("down: HTTP 503");
      },
    };
    const d = { ...deps(null), sources: registry(down, opener()), sleep: async () => {} };
    const { run } = await planRound(d, {
      ask: { text: "x", kind: "web" },
      planFile: { ...planFile, sources: ["down", "opener"] },
      model: null,
    });
    const err = await search(d, run, [{ terms: "a", why: "w" }], agent).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Transient);
    expect(calls).toBe(3);
    const trace = await d.ledger.trace(run);
    expect(trace.filter((r) => r.type === "done").map((r) => r.step)).toEqual(["plan"]);
    // The failed tries' spends stay; with the source up, the same query runs once more.
    const up = { ...d, sources: registry({ ...fake, name: "down" }, opener()) };
    await search(up, run, [], agent);
    const state = fold(run, await up.ledger.trace(run));
    expect(state.spends.filter((x) => x.op === "search" && x.ok)).toHaveLength(1);
    expect(state.hits).toHaveLength(2);
  });

  it("keeps what an extract batch wrote when one document's extract fails for good", async () => {
    const broken: typeof claimExtractor = {
      ...claimExtractor,
      extract: (doc, ...rest) => {
        if (doc.url.endsWith("/three")) throw new Error("boom");
        return claimExtractor.extract(doc, ...rest);
      },
    };
    const d = { ...deps(byPage()), extractor: broken };
    const run = await opened(d);
    expect(await extract(d, run)).toMatchObject({ ok: false, note: "boom" });
    let state = fold(run, await d.ledger.trace(run));
    expect(state.findings.map((f) => f.text)).toEqual([
      "38% of placements came from repeat clients.",
    ]);
    expect(state.verdicts).toHaveLength(1);
    await extract({ ...d, extractor: claimExtractor }, run);
    state = fold(run, await d.ledger.trace(run));
    expect(state.verdicts).toHaveLength(2);
    expect(state.findings).toHaveLength(1);
  });

  it("says what an extract finished when the model drops out mid-batch", async () => {
    const flaky: typeof claimExtractor = {
      ...claimExtractor,
      extract: (doc, ...rest) => {
        if (doc.url.endsWith("/three")) throw new Transient("Connect Timeout Error");
        return claimExtractor.extract(doc, ...rest);
      },
    };
    const d = { ...deps(byPage()), extractor: flaky, sleep: async () => {} };
    const run = await opened(d);
    const err = await extract(d, run).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Transient);
    expect((err as Error).message).toBe(
      "Connect Timeout Error (1 findings from 1 of 2 documents before it stopped; run the step again for the rest)",
    );
  });

  it("continues an extract the output cap cut: both asks a spend that worked, with tokens", async () => {
    let askedOne = 0;
    const model = byPage((prompt) => {
      if (prompt.includes("DOCUMENT: https://a.example/one") && !askedOne++)
        throw new Cut(
          "cut",
          '{"findings": [{"text": "38% of placements came from repeat clients.", "quote": "38% of placements came from repeat clients"}, {"text": "half',
          { input: 100, output: 50 },
        );
    });
    const d = deps(model);
    const run = await opened(d);
    const did = await extract(d, run);
    expect(did.ok).toBe(true);
    expect(askedOne).toBe(2);
    const state = fold(run, await d.ledger.trace(run));
    expect(state.findings.map((f) => f.proof.quote)).toEqual([
      "38% of placements came from repeat clients",
    ]);
    const asks = state.spends.filter((x) => x.op === "ask" && x.on);
    expect(asks.map((x) => [x.ok, x.tokens])).toEqual([
      [true, { input: 100, output: 50 }],
      [true, undefined],
      [true, undefined],
    ]);
    expect(did.note).toContain("1 cut answers continued");
  });

  it("lets an opener in by opens to read, never to search", async () => {
    const both: Source = {
      name: "both",
      kind: "search",
      cost: "free",
      search: async () => [{ url: "https://b.example/four" }],
      open: async (h) => ({ url: h.url, media: "text", text: pages[h.url] ?? "" }),
    };
    const d = { ...deps(null), sources: registry(fake, both) };
    const { run } = await planRound(d, {
      ask: { text: "x", kind: "web" },
      planFile: { ...planFile, sources: ["fake"] },
      opens: ["both"],
      model: null,
    });
    const searched = await search(d, run, [{ terms: "a", why: "w" }], agent);
    const hits = searched.wrote.flatMap((r) => (r.type === "hit" ? [r.id] : []));
    await open(d, run, { hits, why: "w" }, agent);
    const state = fold(run, await d.ledger.trace(run));
    expect(state.snapshot?.opens).toEqual(["both"]);
    const spends = state.spends.map((s) => `${s.source} ${s.op}`);
    expect(spends).not.toContain("both search");
    expect(spends).toContain("both open");
    expect(state.documents.map((x) => x.url)).toEqual([
      "https://a.example/one",
      "https://a.example/two",
    ]);
  });
});

describe("allowList", () => {
  it("keeps the names wanted; the other openers join only to open, unless the list is by hand", () => {
    const both: Source = {
      ...fake,
      name: "both",
      open: async (h) => ({ url: h.url, media: "text", text: "" }),
    };
    const sources = registry(fake, video, both);
    const warned: string[] = [];
    expect(allowList(sources, ["fake", "gone"], false, (l) => warned.push(l))).toEqual({
      sources: ["fake"],
      opens: ["video", "both"],
    });
    expect(warned).toEqual(["no source named gone here: skipped"]);
    expect(allowList(sources, ["fake"], true)).toEqual({ sources: ["fake"], opens: [] });
  });
});
