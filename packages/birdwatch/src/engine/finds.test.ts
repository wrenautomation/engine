import { describe, expect, it } from "vitest";
import { findsOf } from "./finds.js";

describe("findsOf", () => {
  it("reads a URL and its why in any order, with the marks a paste leaves", () => {
    expect(
      findsOf(
        [
          "https://youtu.be/abc  his hook structure",
          "- his pricing page: https://site.example/pricing",
          "# a note to self",
          "",
          "https://instagram.com/reel/x",
          "the caption formula, read the comments too",
        ].join("\n"),
      ),
    ).toEqual([
      { url: "https://youtu.be/abc", why: "his hook structure" },
      { url: "https://site.example/pricing", why: "his pricing page" },
      { url: "https://instagram.com/reel/x", why: "the caption formula, read the comments too" },
    ]);
  });

  it("gives a URL with no why the shared one, and fails with none", () => {
    expect(findsOf("https://a.example/1\nhttps://a.example/2 two", "his channel")).toEqual([
      { url: "https://a.example/1", why: "his channel" },
      { url: "https://a.example/2", why: "two" },
    ]);
    expect(() => findsOf("https://a.example/1")).toThrow("no why for https://a.example/1");
  });

  it("two URLs on a line share its why; a URL named twice is one find", () => {
    expect(
      findsOf("https://a.example/1, https://a.example/2 both\nhttps://a.example/1 again"),
    ).toEqual([
      { url: "https://a.example/1", why: "both" },
      { url: "https://a.example/2", why: "both" },
    ]);
  });

  it("fails on a note with no URL above it, and on no URL at all", () => {
    expect(() => findsOf("look at this")).toThrow('no URL on or above "look at this"');
    expect(() => findsOf("\n# only a note\n")).toThrow("no URL in the lines");
  });
});
