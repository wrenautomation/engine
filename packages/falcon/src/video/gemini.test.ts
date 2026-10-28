import { Cut, Filtered, fakeModel } from "@wrenautomation/models";
import { describe, expect, it, vi } from "vitest";
import { geminiVideo, readMedia } from "./gemini.js";

const clip = [
  { type: "video" as const, data: new URL("https://example.com/v"), mediaType: "video/mp4" },
];

describe("geminiVideo", () => {
  it("is null when no key works: a dead fleet gets no media posted", async () => {
    const asked: string[] = [];
    const dead = (async (url: string) => {
      asked.push(String(url));
      return new Response("{}", { status: 403 });
    }) as unknown as typeof fetch;
    expect(await geminiVideo(["g1", "g2"], { fetch: dead })).toBeNull();
    expect(asked.every((u) => !u.includes(":generateContent"))).toBe(true);
  });

  it("is a video reader when a key works", async () => {
    const live = (async () => new Response("{}")) as unknown as typeof fetch;
    const m = await geminiVideo(["g1"], { fetch: live });
    expect(m?.takes.has("video")).toBe(true);
    expect(m?.takes.has("audio")).toBe(true);
  });
});

describe("readMedia", () => {
  it("asks once more for a paraphrase after a recitation stop", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const asks: string[] = [];
      const m = fakeModel((ask) => {
        asks.push(ask);
        if (asks.length === 1) throw new Filtered("stopped", "RECITATION", "");
        return " what it says ";
      });
      const text = await readMedia(m, clip, (p) => (p ? "paraphrase it" : "quote it"));
      expect(asks).toEqual(["quote it", "paraphrase it"]);
      expect(text).toBe("what it says");
    } finally {
      warn.mockRestore();
    }
  });

  it("throws a recitation stop on a plain ask, and keeps what a cut answer said", async () => {
    const filtered = fakeModel(() => {
      throw new Filtered("stopped", "RECITATION", "");
    });
    await expect(readMedia(filtered, clip, "transcribe")).rejects.toThrow(Filtered);
    const cut = fakeModel(() => {
      throw new Cut("cut", "[0:00] the first half ");
    });
    expect(await readMedia(cut, clip, "transcribe")).toBe("[0:00] the first half");
  });

  it("sends the parts, then the ask, with a token ceiling and a time limit", async () => {
    const m = fakeModel((_ask, req) => {
      expect(typeof req.prompt === "string" ? [] : req.prompt.map((p) => p.type)).toEqual([
        "video",
        "text",
      ]);
      expect(req.maxTokens).toBeGreaterThan(8192);
      expect(req.signal).toBeInstanceOf(AbortSignal);
      expect(req.resolution).toBe("low");
      return "ok";
    });
    expect(await readMedia(m, clip, "look", { resolution: "low" })).toBe("ok");
  });
});
