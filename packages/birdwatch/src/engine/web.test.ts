import { describe, expect, it } from "vitest";
import type { LedgerRecord } from "../ledger/records.js";
import { webOf } from "./web.js";
import { fold } from "./state.js";

const head = (run: string, id: string, at: string) => ({
  id,
  run,
  round: 1,
  at,
  from: "agent",
  by: "test",
});

/** A run: one query, hits on the URLs given, the first hit read with one finding. */
function runOf(run: string, at: string, urls: string[], channel?: string) {
  const q = `${run}-q`;
  const records = [
    { ...head(run, `${run}-s`, at), type: "snapshot", ask: { text: `ask ${run}`, kind: "web" } },
    { ...head(run, q, at), type: "query", kind: "web", terms: `terms ${run}`, why: "w" },
    ...urls.map((url, i) => ({
      ...head(run, `${run}-h${i}`, at),
      type: "hit",
      url,
      title: `page ${i}`,
      queries: [q],
      ...(channel ? { channel } : {}),
    })),
    {
      ...head(run, `${run}-d`, at),
      type: "document",
      hit: `${run}-h0`,
      url: urls[0],
      media: "html",
      text: "t",
    },
    {
      ...head(run, `${run}-f`, at),
      type: "finding",
      document: `${run}-d`,
      kind: "fact",
      text: "a fact",
      proof: { url: urls[0] },
    },
  ] as unknown as LedgerRecord[];
  return fold(run, records);
}

const a = runOf("A", "2026-11-01T10:00:00Z", ["https://a.com/1", "https://shared.com/x"]);
const b = runOf("B", "2026-11-01T11:00:00Z", ["https://www.shared.com/y", "https://b.com/2"]);
const c = runOf("C", "2026-11-02T09:00:00Z", ["https://c.com/1"]);

describe("webOf", () => {
  it("draws run, query, source, page and finding, with a read page solid", () => {
    const m = webOf([{ group: "11-01", state: a }]);
    const kinds = m.nodes.map((n) => n.kind);
    expect(kinds.filter((k) => k === "run")).toHaveLength(1);
    expect(kinds.filter((k) => k === "source")).toHaveLength(0);
    expect(m.nodes.find((n) => n.id === "A")?.label).toBe("ask A");
    expect(m.nodes.find((n) => n.id === "A-h0")).toMatchObject({ kind: "page", read: true });
    expect(m.nodes.find((n) => n.id === "A-h1")).toMatchObject({
      kind: "page",
      read: false,
      key: "site:shared.com",
    });
    expect(m.nodes.find((n) => n.id === "A-f")).toMatchObject({ kind: "finding", kept: true });
    expect(m.edges.filter((e) => e.kind === "tree")).toHaveLength(m.nodes.length - 1);
  });

  it("is stable: the same runs in any order draw the same web", () => {
    const one = webOf([
      { group: "11-01", state: a },
      { group: "11-01", state: b },
    ]);
    const two = webOf([
      { group: "11-01", state: b },
      { group: "11-01", state: a },
    ]);
    expect(two).toEqual(one);
  });

  it("a new run moves no older node", () => {
    const before = webOf([
      { group: "11-01", state: a },
      { group: "11-01", state: b },
    ]);
    const after = webOf([
      { group: "11-01", state: a },
      { group: "11-01", state: b },
      { group: "11-02", state: c },
    ]);
    const at = new Map(after.nodes.map((n) => [n.id, [n.x, n.y]]));
    for (const n of before.nodes) if (n.kind !== "hub") expect(at.get(n.id)).toEqual([n.x, n.y]);
  });

  it("a site two runs used is a hub between them; a site one run used is not", () => {
    const m = webOf([
      { group: "11-01", state: a },
      { group: "11-01", state: b },
    ]);
    const hubs = m.nodes.filter((n) => n.kind === "hub");
    expect(hubs.map((h) => h.label)).toEqual(["shared.com"]);
    const [hub] = hubs;
    const ra = m.nodes.find((n) => n.id === "A");
    const rb = m.nodes.find((n) => n.id === "B");
    expect(hub?.x).toBeCloseTo(((ra?.x ?? 0) + (rb?.x ?? 0)) / 2);
    expect(m.edges.filter((e) => e.kind === "hub" && e.source === hub?.id)).toHaveLength(2);
  });

  it("a site or channel with two pages is a source; with one, the page holds it", () => {
    const v = runOf(
      "V",
      "2026-11-01T12:00:00Z",
      ["https://youtube.com/watch?v=1", "https://youtube.com/watch?v=2"],
      "Ali Abdaal",
    );
    const m = webOf([{ group: "11-01", state: v }]);
    const source = m.nodes.find((n) => n.kind === "source");
    expect(source).toMatchObject({ label: "Ali Abdaal", key: "channel:Ali Abdaal" });
    expect(m.edges.filter((e) => e.source === source?.id)).toHaveLength(2);
  });

  it("keeps islands apart: no two runs overlap", () => {
    const m = webOf([
      { group: "11-01", state: a },
      { group: "11-01", state: b },
      { group: "11-02", state: c },
    ]);
    const runs = m.nodes.filter((n) => n.kind === "run");
    for (const r of runs)
      for (const s of runs)
        if (r !== s) expect(Math.hypot(r.x - s.x, r.y - s.y)).toBeGreaterThan(700);
  });
});
