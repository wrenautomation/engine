import { describe, expect, it } from "vitest";
import {
  allOpen,
  depthsOf,
  type FoldNode,
  fullDepth,
  openKey,
  openSet,
  pathTo,
  reveal,
  stepDepth,
  toggle,
} from "./tree.js";

/** Send holds an A/B test; wait and sort stand alone. A hand node sits in sort. */
const NODES: FoldNode[] = [
  { id: "send", label: "Send" },
  { id: "ab", parent: "send", label: "Subject test" },
  { id: "wait", label: "Wait" },
  { id: "sort", label: "Sort reply" },
  { id: "twin", parent: "sort", label: "Platforms", hand: true },
];
const ids = (s: ReadonlySet<string>) => [...s].sort();

describe("depths", () => {
  it("counts how deep each node sits, and the cut that opens all but hand nodes", () => {
    expect(depthsOf(NODES).get("ab")).toBe(1);
    expect(depthsOf(NODES).get("wait")).toBe(0);
    expect(fullDepth(NODES)).toBe(2);
    expect(fullDepth([])).toBe(0);
  });

  it("ends the walk at a loop or a missing parent", () => {
    const loop: FoldNode[] = [
      { id: "a", parent: "b", label: "A" },
      { id: "b", parent: "a", label: "B" },
      { id: "c", parent: "gone", label: "C" },
    ];
    expect(depthsOf(loop).get("c")).toBe(0);
    expect(Number.isFinite(fullDepth(loop))).toBe(true);
  });

  it("names the path to a node, outermost first", () => {
    expect(pathTo(NODES, "ab").map((n) => n.id)).toEqual(["send", "ab"]);
  });
});

describe("openSet", () => {
  it("opens the nodes above the cut and never a hand node", () => {
    expect(ids(openSet(NODES, { depth: 0, open: {} }))).toEqual([]);
    expect(ids(openSet(NODES, { depth: 1, open: {} }))).toEqual(["send", "sort", "wait"]);
    expect(ids(openSet(NODES, { depth: 9, open: {} }))).toEqual(["ab", "send", "sort", "wait"]);
  });

  it("puts hand changes on top of the cut", () => {
    expect(ids(openSet(NODES, { depth: 1, open: { wait: false, twin: true } }))).toEqual([
      "send",
      "sort",
      "twin",
    ]);
  });

  it("never counts a node inside a closed one, so two folds that draw alike match", () => {
    const a = openSet(NODES, { depth: 0, open: { ab: true } });
    expect(ids(a)).toEqual([]);
    expect(openKey(a)).toBe(openKey(openSet(NODES, { depth: 0, open: {} })));
  });

  it("keys a set the same in any order", () => {
    expect(openKey(new Set(["b", "a"]))).toBe(openKey(new Set(["a", "b"])));
  });

  it("opens every node, hand nodes too, for a focus", () => {
    expect(ids(allOpen(NODES))).toEqual(["ab", "send", "sort", "twin", "wait"]);
  });
});

describe("toggle", () => {
  it("opens a node and the nodes it sits in", () => {
    const f = toggle(NODES, { depth: 0, open: {} }, "ab", true);
    expect(f).toEqual({ depth: 0, open: { send: true, ab: true } });
    expect(ids(openSet(NODES, f))).toEqual(["ab", "send"]);
  });

  it("closes a node and keeps the cut", () => {
    expect(toggle(NODES, { depth: 1, open: {} }, "wait", false)).toEqual({
      depth: 1,
      open: { wait: false },
    });
  });

  it("drops a change that equals the cut", () => {
    const shut = toggle(NODES, { depth: 1, open: {} }, "wait", false);
    expect(toggle(NODES, shut, "wait", true)).toEqual({ depth: 1, open: {} });
  });

  it("keeps a hand node open by hand at the deepest cut", () => {
    expect(toggle(NODES, { depth: 2, open: {} }, "twin", true).open).toEqual({ twin: true });
  });
});

describe("stepDepth and reveal", () => {
  it("steps inside the cuts and clears hand changes", () => {
    expect(stepDepth(NODES, 0, -1)).toEqual({ depth: 0, open: {} });
    expect(stepDepth(NODES, 0, 1)).toEqual({ depth: 1, open: {} });
    expect(stepDepth(NODES, 2, 1)).toEqual({ depth: 2, open: {} });
    expect(stepDepth(NODES, 9, -1)).toEqual({ depth: 1, open: {} });
  });

  it("opens the path to a node and closes the rest", () => {
    const f = reveal(NODES, "ab");
    expect(ids(openSet(NODES, f))).toEqual(["ab", "send"]);
    expect(reveal(NODES, undefined)).toEqual({ depth: 0, open: {} });
  });
});
