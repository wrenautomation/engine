import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeModel } from "@wrenautomation/models";
import { describe, expect, it } from "vitest";
import { captionsBody, hearAudio } from "./read.js";
import { clock } from "./tools.js";

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("captions", () => {
  it("renders per chapter with a marker a minute", () => {
    const body = captionsBody(
      {
        id: "v1",
        title: "T",
        chapters: [
          { start_time: 0, end_time: 90, title: "Intro" },
          { start_time: 90, end_time: 200, title: "Copy" },
        ],
      },
      {
        events: [
          { tStartMs: 1000, segs: [{ utf8: "hello" }, { utf8: " there" }] },
          { tStartMs: 70000, segs: [{ utf8: "later" }] },
          { tStartMs: 95000 },
          { tStartMs: 95000, segs: [{ utf8: "second" }] },
          { tStartMs: 3700000, segs: [{ utf8: "past the end" }] },
        ],
      },
    );
    expect(body).toContain("## [0:00] Intro\n[0:01] hello there \n[1:10] later");
    expect(body).toContain("## [1:30] Copy\n[1:35] second");
    expect(body).not.toContain("past the end");
    expect(clock(3725)).toBe("1:02:05");
  });

  it("is one chapter, the whole video, when yt-dlp lists none", () => {
    const body = captionsBody(
      { id: "v2", title: "Whole", duration: 30 },
      { events: [{ tStartMs: 0, segs: [{ utf8: "all of it" }] }] },
    );
    expect(body).toBe("## [0:00] Whole\n[0:00] all of it\n");
  });
});

describe.skipIf(!hasFfmpeg)("audio", () => {
  it("cuts a file into clips and keeps their order and times", async () => {
    const dir = await mkdtemp(join(tmpdir(), "read-audio-test-"));
    try {
      const file = join(dir, "episode");
      execFileSync("ffmpeg", [
        ...["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=f=440:d=3"],
        ...["-ac", "1", "-c:a", "libopus", "-b:a", "8k", "-f", "ogg", file],
      ]);
      const asks: string[] = [];
      const model = fakeModel((ask, req) => {
        const parts = typeof req.prompt === "string" ? [] : req.prompt;
        expect(parts[0]).toMatchObject({ type: "audio", mediaType: "audio/ogg" });
        const at = /clip starts at ([\d:]+)/.exec(ask)?.[1] ?? "?";
        asks.push(at);
        return `heard ${at}`;
      });
      // Two-second clips of a three-second tone: a 700 s episode took minutes to encode and cut.
      const r = await hearAudio(file, { model, clipS: 2 });
      expect(asks.sort()).toEqual(["0:00", "0:02"]);
      expect(r.duration).toBe(3);
      expect(r.speech.indexOf("heard 0:00")).toBeLessThan(r.speech.indexOf("heard 0:02"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
