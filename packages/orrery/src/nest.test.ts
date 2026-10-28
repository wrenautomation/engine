import { describe, expect, it } from "vitest";
import { type Engine, type Kid, type NestCache, nest } from "./nest.js";
import type { FoldNode } from "./tree.js";

// a, with b (holds c, d) and e
const nodes: FoldNode[] = [
  { id: "a", label: "a" },
  { id: "b", parent: "a", label: "b" },
  { id: "c", parent: "b", label: "c" },
  { id: "d", parent: "b", label: "d" },
  { id: "e", parent: "a", label: "e" },
];
const pad = { top: 30, side: 10, bottom: 10 };
/** A row, 20 apart. */
const calls: string[] = [];
const row: Engine<string> = async (id, kids: readonly Kid[]) => {
  calls.push(id);
  let x = 0;
  const at: Record<string, [number, number]> = {};
  for (const k of kids) {
    at[k.id] = [x, 0];
    x += k.w + 20;
  }
  return { w: x - 20, h: Math.max(...kids.map((k) => k.h)), at, extra: id };
};
const size = () => ({ w: 100, h: 50 });

describe("nest", () => {
  it("lays a closed level out once, with no container boxes", async () => {
    calls.length = 0;
    const r = await nest({ nodes, root: "a", open: new Set(), size, pad, engine: row });
    expect(calls).toEqual(["a"]);
    expect(r.boxes.map((b) => [b.id, b.x, b.open])).toEqual([
      ["b", 0, false],
      ["e", 120, false],
    ]);
  });

  it("sizes an open kid by its layout and places its kids inside, absolute", async () => {
    calls.length = 0;
    const r = await nest({ nodes, root: "a", open: new Set(["b"]), size, pad, engine: row });
    expect(calls).toEqual(["b", "a"]);
    const b = r.boxes.find((x) => x.id === "b");
    expect(b).toMatchObject({ x: 0, y: 0, w: 240, h: 90, open: true });
    expect(r.boxes.find((x) => x.id === "c")).toMatchObject({ x: 10, y: 30, parent: "b" });
    expect(r.boxes.find((x) => x.id === "d")).toMatchObject({ x: 130, y: 30, parent: "b" });
    expect(r.boxes.find((x) => x.id === "e")).toMatchObject({ x: 260, y: 0 });
    expect(r.boxes.map((x) => x.id)).toEqual(["b", "c", "d", "e"]);
    expect(r.levels.map((l) => [l.id, l.x, l.y, l.laid.extra])).toEqual([
      ["a", 0, 0, "a"],
      ["b", 10, 30, "b"],
    ]);
  });

  it("re-lays only what changed", async () => {
    const cache: NestCache<string> = new Map();
    await nest({ nodes, root: "a", open: new Set(["b"]), size, pad, engine: row, cache });
    calls.length = 0;
    await nest({ nodes, root: "a", open: new Set(["b"]), size, pad, engine: row, cache });
    expect(calls).toEqual([]);
    await nest({ nodes, root: "a", open: new Set(), size, pad, engine: row, cache });
    expect(calls).toEqual(["a"]);
  });

  it("treats an open leaf as a closed box", async () => {
    const r = await nest({ nodes, root: "a", open: new Set(["e"]), size, pad, engine: row });
    expect(r.boxes.find((x) => x.id === "e")?.open).toBe(false);
  });
});
