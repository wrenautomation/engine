import { describe, expect, it } from "vitest";
import { labelAsk, labelMatch, parseLabels, shotTimes } from "./index.js";

const SETS = {
  type: ["ui", "logo"],
  move: ["static", "push"],
  in: ["cut", "fade"],
};

describe("shot labels", () => {
  it("holds an answer to the sets: outside one, or unreadable, is null", () => {
    expect(parseLabels('Sure: {"type": "UI", "move": "push", "in": "cut"}', SETS)).toEqual({
      type: "ui",
      move: "push",
      in: "cut",
    });
    expect(parseLabels('{"type": "b-roll", "move": null, "in": "fade"}', SETS)).toEqual({
      type: null,
      move: null,
      in: "fade",
    });
    expect(parseLabels("I can't tell.", SETS)).toEqual({ type: null, move: null, in: null });
  });

  it("frames a shot at its start, middle and end, and just before it unless it opens the film", () => {
    expect(shotTimes({ t: 0, len: 4 })).toEqual([0.3, 2, 3.7]);
    expect(shotTimes({ t: 10, len: 1 })).toEqual([9.8, 10.15, 10.5, 10.85]);
    expect(labelAsk(SETS, true)).toContain("One of: static, push.");
  });

  it("scores each label on the shots a hand labelled", () => {
    const m = labelMatch(
      [
        { type: "ui", move: "push", in: "cut" },
        { type: "ui", move: null, in: "fade" },
      ],
      [
        { type: "ui", move: "static", in: "cut" },
        { type: "logo", move: "push", in: null },
      ],
    );
    expect(m.type).toMatchObject({ n: 2, hits: 1, share: 0.5, misses: [["ui", "logo"]] });
    expect(m.move).toMatchObject({ n: 1, hits: 0 });
    expect(m.in).toMatchObject({ n: 2, hits: 1, misses: [["fade", null]] });
  });
});
