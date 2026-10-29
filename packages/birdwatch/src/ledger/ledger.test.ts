import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FilesLedger } from "./files.js";
import { countingIds } from "./ids.js";
import { yieldRows } from "./ledger.js";
import { MemoryLedger } from "./memory.js";
import { type Envelope, LedgerRecord } from "./records.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const tmp = async () => {
  const d = await mkdtemp(join(tmpdir(), "birdwatch-ledger-"));
  dirs.push(d);
  return d;
};

const base = (over: Partial<Envelope> = {}): Envelope => ({
  id: "r-000000",
  run: "run1",
  round: 1,
  at: "2026-10-27T10:00:00.000Z",
  from: "tool",
  by: "test",
  ...over,
});

/** A run: two queries by two proposers, three hits, two reads, three findings, two kept. */
const sample = (): LedgerRecord[] => {
  const ids = countingIds();
  const q1 = ids();
  const q2 = ids();
  const h1 = ids();
  const h2 = ids();
  const h3 = ids();
  const d1 = ids();
  const d2 = ids();
  const f1 = ids();
  const f2 = ids();
  const f3 = ids();
  const t = (n: number) => `2026-10-27T10:00:${String(n).padStart(2, "0")}.000Z`;
  return [
    {
      ...base({ id: q1, at: t(1), step: "plan", from: "ai", by: "model" }),
      type: "query",
      kind: "web",
      terms: "a",
      why: "w",
    },
    {
      ...base({ id: q2, at: t(2), step: "plan", from: "human", by: "will" }),
      type: "query",
      kind: "web",
      terms: "b",
      why: "w",
    },
    {
      ...base({ id: h1, at: t(3), step: "fetch" }),
      type: "hit",
      url: "https://a/1",
      key: "https://a/1",
      sources: ["searxng", "exa"],
      queries: [q1],
      channel: "Blog",
    },
    {
      ...base({ id: h2, at: t(4), step: "fetch" }),
      type: "hit",
      url: "https://a/2",
      key: "https://a/2",
      sources: ["searxng"],
      queries: [q2],
    },
    {
      ...base({ id: h3, at: t(5), step: "fetch" }),
      type: "hit",
      url: "https://a/3",
      key: "https://a/3",
      sources: ["exa"],
      queries: [q1, q2],
    },
    {
      ...base({ id: d1, at: t(6), step: "read" }),
      type: "document",
      hit: h1,
      url: "https://a/1",
      media: "html",
      text: "t",
    },
    {
      ...base({ id: d2, at: t(7), step: "read" }),
      type: "document",
      hit: h2,
      url: "https://a/2",
      media: "html",
      text: "t",
    },
    {
      ...base({ id: f1, at: t(8), step: "extract", from: "ai", by: "model" }),
      type: "finding",
      document: d1,
      kind: "claim",
      text: "x",
      proof: { url: "https://a/1", quote: "q" },
    },
    {
      ...base({ id: f2, at: t(9), step: "extract", from: "ai", by: "model" }),
      type: "finding",
      document: d1,
      kind: "claim",
      text: "y",
      proof: { url: "https://a/1", quote: "q2" },
    },
    {
      ...base({ id: f3, at: t(10), step: "extract", from: "ai", by: "model" }),
      type: "finding",
      document: d2,
      kind: "claim",
      text: "z",
      proof: { url: "https://a/2", quote: "q3" },
    },
    {
      ...base({ id: ids(), at: t(11), step: "review", from: "ai", by: "model" }),
      type: "call",
      on: f1,
      verdict: "keep",
      why: "good",
    },
    {
      ...base({ id: ids(), at: t(12), step: "review", from: "ai", by: "model" }),
      type: "call",
      on: f2,
      verdict: "keep",
      why: "good",
    },
    {
      ...base({ id: ids(), at: t(13), from: "human", by: "will" }),
      type: "call",
      on: f2,
      verdict: "drop",
      why: "marketing",
    },
    {
      ...base({ id: ids(), at: t(14), step: "review", from: "ai", by: "model" }),
      type: "call",
      on: f3,
      verdict: "keep",
      why: "good",
    },
  ];
};

describe("records", () => {
  it("rejects a record of an unknown type and one without the envelope", () => {
    expect(LedgerRecord.safeParse({ ...base(), type: "note" }).success).toBe(false);
    expect(LedgerRecord.safeParse({ type: "done", step: "plan", ok: true }).success).toBe(false);
    expect(
      LedgerRecord.safeParse({ ...base({ step: "plan" }), type: "done", ok: true }).success,
    ).toBe(true);
    expect(LedgerRecord.safeParse({ ...base(), type: "steer", text: "numbers only" }).success).toBe(
      true,
    );
    expect(LedgerRecord.safeParse({ ...base(), type: "steer", text: "" }).success).toBe(false);
  });
});

describe("yield", () => {
  it("folds per source, proposer, channel and kind; the latest call decides kept", () => {
    const rows = yieldRows(sample());
    const row = (k: string, v: string) => rows.find((r) => (r as Record<string, unknown>)[k] === v);
    expect(row("source", "searxng")).toEqual({
      source: "searxng",
      hits: 2,
      reads: 2,
      proposed: 3,
      kept: 2,
    });
    expect(row("source", "exa")).toEqual({
      source: "exa",
      hits: 2,
      reads: 1,
      proposed: 2,
      kept: 1,
    });
    expect(row("by", "will")).toEqual({ by: "will", hits: 2, reads: 1, proposed: 1, kept: 1 });
    expect(row("by", "model")).toEqual({ by: "model", hits: 2, reads: 1, proposed: 2, kept: 1 });
    expect(row("channel", "Blog")).toEqual({
      channel: "Blog",
      hits: 1,
      reads: 1,
      proposed: 2,
      kept: 1,
    });
    expect(row("kind", "web")).toEqual({ kind: "web", hits: 3, reads: 2, proposed: 3, kept: 2 });
    expect(yieldRows(sample(), { source: "exa" })).toHaveLength(1);
  });
});

describe("files ledger", () => {
  it("two writers interleave on one run; the trace sorts by time then id; scan filters", async () => {
    const root = await tmp();
    const a = new FilesLedger(root, "will");
    const b = new FilesLedger(root, "session/1");
    const all = sample();
    for (const [i, r] of all.entries()) await (i % 2 ? b : a).append(r);
    const trace = await new FilesLedger(root, "reader").trace("run1");
    expect(trace.map((r) => r.id)).toEqual(all.map((r) => r.id));
    expect(await readFile(join(root, "runs", "run1", "session-1.jsonl"), "utf8")).toContain(
      '"type":"query"',
    );
    const calls = await a.scan({ type: "call", from: "human" });
    expect(calls).toHaveLength(1);
    expect(await a.scan({ run: "none" })).toEqual([]);
    expect((await a.yield({ by: "will" }))[0]?.kept).toBe(1);
    expect(a.problems).toEqual([]);
  });

  it("skips a partial last line and a bad record, and reports both", async () => {
    const root = await tmp();
    const a = new FilesLedger(root, "w");
    const [first] = sample();
    if (!first) throw new Error("sample");
    await a.append(first);
    await writeFile(
      a.file("run1"),
      `${JSON.stringify({ ...base(), type: "nope" })}\n{"type":"hit","id":"x`,
      { flag: "a" },
    );
    const trace = await a.trace("run1");
    expect(trace.map((r) => r.id)).toEqual([first.id]);
    expect(a.problems.map((p) => p.why)).toEqual([
      expect.stringContaining("Invalid"),
      "partial last line",
    ]);
  });

  it("reads and writes plan files beside the runs", async () => {
    const root = await tmp();
    const a = new FilesLedger(root, "w");
    expect(await a.readPlan("web")).toBeNull();
    const { defaultPlanFile } = await import("../engine/plan.js");
    const pf = defaultPlanFile("web");
    await a.writePlan(pf);
    expect(await a.readPlan("web")).toEqual(pf);
  });
});

describe("memory ledger", () => {
  it("answers the same four calls", async () => {
    const m = new MemoryLedger();
    for (const r of sample().reverse()) await m.append(r);
    expect((await m.trace("run1"))[0]?.type).toBe("query");
    expect((await m.scan({ step: "extract" })).length).toBe(3);
    expect((await m.yield()).length).toBeGreaterThan(0);
  });
});
