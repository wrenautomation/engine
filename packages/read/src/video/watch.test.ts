import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeModel, InputRejected, type Model, modelOf } from "@wrenautomation/models";
import { fakeEar } from "@wrenautomation/models/hear";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  cutsLine,
  frameCounts,
  onScreenLines,
  parseScenes,
  readScreen,
  readWatchFacts,
  renderWatched,
  type Watched,
  watchFile,
} from "./index.js";

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** A vision model, faked: each call's ask text and image count go to `log`. */
const eyeOf = (answer: (ask: string, images: number) => string, log: string[] = []): Model =>
  fakeModel((ask, req) => {
    log.push(ask);
    const parts = typeof req.prompt === "string" ? [] : req.prompt;
    return answer(ask, parts.filter((p) => p.type === "image").length);
  }, "fake:eye");
/** The frame times a vision ask lists. */
const timesIn = (text: string) =>
  (/Their times: ([^.]+)\./.exec(text)?.[1] ?? "").split(", ").filter(Boolean);

const shots = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ at: i * 2, jpeg: Buffer.from(`frame${i}`) }));

describe("readScreen", () => {
  it("tags each line with its frame time; a frame with no line stays not read, never filled", async () => {
    const calls: string[] = [];
    const eye = eyeOf((ask, images) => {
      expect(images).toBe(8);
      // The model drops the frame at 0:06 and sees no text at 0:08.
      return timesIn(ask)
        .filter((t) => t !== "0:06")
        .map((t) => `[${t}] ${t === "0:08" ? "none" : `text at ${t}`}`)
        .join("\n");
    }, calls);
    const frames = await readScreen(shots(8), eye);
    expect(calls).toHaveLength(1);
    expect(frames.map((f) => f.at)).toEqual([0, 2, 4, 6, 8, 10, 12, 14]);
    expect(frames[3]).toEqual({ at: 6, text: null });
    expect(frames[4]).toEqual({ at: 8, text: "" });
    expect(frames[5]?.text).toBe("text at 0:10");
    expect(frameCounts({ frames })).toEqual({ read: 7, unread: 1 });
    expect(onScreenLines({ frames })).toEqual([
      "[0:00] text at 0:00",
      "[0:02] text at 0:02",
      "[0:04] text at 0:04",
      "[0:06] (not read)",
      "[0:10] text at 0:10",
      "[0:12] text at 0:12",
      "[0:14] text at 0:14",
    ]);
  });

  it("splits frames into batches of 8 and keeps their order", async () => {
    const batches: string[][] = [];
    const eye = eyeOf((ask) => {
      const times = timesIn(ask);
      batches.push(times);
      return times.map((t) => `[${t}] t${t}`).join("\n");
    });
    const frames = await readScreen(shots(11), eye);
    expect(batches.map((b) => b.length).sort()).toEqual([3, 8]);
    expect(frames.map((f) => f.at)).toEqual(Array.from({ length: 11 }, (_, i) => i * 2));
    expect(
      frames.every(
        (f) => f.text === `t${Math.floor(f.at / 60)}:${String(f.at % 60).padStart(2, "0")}`,
      ),
    ).toBe(true);
  });

  it("retries a refused batch once with the text-only ask, keeping what the first answer read", async () => {
    const asks: string[] = [];
    const eye = eyeOf(
      (ask) =>
        asks.length === 1
          ? "I can't assist with describing images of people."
          : timesIn(ask)
              .map((t) => `[${t}] says ${t}`)
              .join("\n"),
      asks,
    );
    const frames = await readScreen(shots(3), eye);
    expect(asks).toHaveLength(2);
    expect(asks[0]).not.toContain("Ignore people");
    expect(asks[1]).toContain("Read only on-screen text, UI and graphics. Ignore people.");
    expect(frames.map((f) => f.text)).toEqual(["says 0:00", "says 0:02", "says 0:04"]);
  });

  it("a frame refused in a line is asked again; one the first answer read keeps its line", async () => {
    const asks: string[] = [];
    const eye = eyeOf(
      () =>
        asks.length === 1
          ? "[0:00] SALE 50%\n[0:02] I'm sorry, I can't describe images of people.\n[0:04] none"
          : "[0:00] changed\n[0:02] a title card\n[0:04] changed",
      asks,
    );
    const frames = await readScreen(shots(3), eye);
    expect(asks).toHaveLength(2);
    expect(frames.map((f) => f.text)).toEqual(["SALE 50%", "a title card", ""]);
  });

  it("a frame still refused after the retry is not read, and a batch is asked twice at most", async () => {
    const asks: string[] = [];
    const frames = await readScreen(
      shots(2),
      eyeOf(() => "I'm sorry, but I can't help with that.", asks),
    );
    expect(asks).toHaveLength(2);
    expect(frames).toEqual([
      { at: 0, text: null },
      { at: 2, text: null },
    ]);
  });

  it("an unasked batch leaves its frames not read; all of them failing throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const half = eyeOf((ask) => {
        if (!ask.includes("0:00,")) throw new InputRejected("bad request");
        return timesIn(ask)
          .map((t) => `[${t}] ok`)
          .join("\n");
      });
      const frames = await readScreen(shots(10), half);
      expect(frames.slice(0, 8).every((f) => f.text === "ok")).toBe(true);
      expect(frames.slice(8)).toEqual([
        { at: 16, text: null },
        { at: 18, text: null },
      ]);
      const none = eyeOf(() => {
        throw new InputRejected("bad request");
      });
      await expect(readScreen(shots(2), none)).rejects.toThrow(/fake:eye 0:00: bad request/);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("scene detector output", () => {
  const csv = [
    "Scene Number,Start Frame,Start Timecode,Start Time (seconds),End Frame,End Timecode,End Time (seconds),Length (frames),Length (timecode),Length (seconds)",
    "1,1,00:00:00.000,0.000,80,00:00:03.337,3.337,80,00:00:03.337,3.337",
    "2,81,00:00:03.337,3.337,175,00:00:07.299,7.299,95,00:00:03.962,3.962",
    "3,176,00:00:07.299,7.299,274,00:00:11.428,11.428,99,00:00:04.129,4.129",
  ];
  it("reads a cut where each scene after the first starts", () => {
    expect(parseScenes(csv.join("\n"))).toEqual([3.34, 7.3]);
    expect(parseScenes(csv.slice(0, 2).join("\n"))).toEqual([]);
    expect(parseScenes("")).toEqual([]);
  });
  it("renders a film's facts fence and reads it back; a reel's page has none", () => {
    const w: Watched = {
      durationS: 12.5,
      cuts: [7.3],
      cutsBy: { hash: [3.34, 7.3], adaptive: [3.34] },
      audio: true,
      speech: "",
      frames: [],
    };
    const md = renderWatched(w);
    expect(readWatchFacts(md)).toEqual({
      duration_s: 12.5,
      audio: true,
      cuts_by: { ffmpeg: [7.3], hash: [3.34, 7.3], adaptive: [3.34] },
    });
    const { cutsBy: _, ...reel } = w;
    expect(renderWatched(reel)).not.toContain("## Facts");
    expect(readWatchFacts(renderWatched(reel))).toBeNull();
  });
});

describe.skipIf(!hasFfmpeg)("watchFile", () => {
  let dir = "";
  let video = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "watch-test-"));
    video = join(dir, "fixture.mp4");
    // Made here, never committed: 2 s of colour bars, then 2 s of red (one cut), and a tone.
    execFileSync("ffmpeg", [
      ...["-hide_banner", "-loglevel", "error", "-y"],
      ...[
        "-filter_complex",
        "smptebars=s=320x240:r=10:d=2[a];color=c=red:s=320x240:r=10:d=2,format=yuv420p[b];[a]format=yuv420p[a2];[a2][b]concat=n=2:v=1:a=0[v];sine=f=440:d=4[s]",
      ],
      ...["-map", "[v]", "-map", "[s]", "-c:v", "libx264", "-c:a", "aac", "-shortest", video],
    ]);
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  /** The eye, ear and video model, faked: every call is logged. */
  const fakes = () => {
    const log: { by: string; images: number; ask: string; media?: string }[] = [];
    const eye = fakeModel((ask, req) => {
      const parts = typeof req.prompt === "string" ? [] : req.prompt;
      log.push({ by: "eye", images: parts.filter((p) => p.type === "image").length, ask });
      return timesIn(ask)
        .map((t) => `[${t}] caption ${t}`)
        .join("\n");
    }, "fake:eye");
    const ear = fakeEar((audio, o) => {
      log.push({ by: "ear", images: 0, ask: `${audio.mediaType} ${o.language}` });
      expect(audio.data.byteLength).toBeGreaterThan(1000);
      return "hello from the fixture";
    });
    const video = fakeModel((ask, req) => {
      const parts = typeof req.prompt === "string" ? [] : req.prompt;
      const media = parts.find((p) => p.type === "video");
      log.push({ by: "video", images: 0, ask, ...(media ? { media: media.mediaType } : {}) });
      return "[0:00:01] [visual] a slide";
    }, "fake:video");
    return { eye, ear, video, log };
  };

  it("reads a file: ffmpeg facts, the ear's speech and the eye's screen, every line on its frame time", async () => {
    const { eye, ear, log } = fakes();
    const w = await watchFile(video, { eye, ear });
    expect(w.durationS).toBeGreaterThan(3.5);
    expect(w.durationS).toBeLessThan(4.5);
    expect(w.speech).toBe("hello from the fixture");
    expect(w.cuts).toHaveLength(1);
    expect(w.cuts[0]).toBeGreaterThan(1.8);
    expect(w.cuts[0]).toBeLessThan(2.2);
    expect(w.frames.map((f) => f.at)).toEqual([0, 2]);
    expect(w.frames.map((f) => f.text)).toEqual(["caption 0:00", "caption 0:02"]);
    expect(w.whole).toBeUndefined();

    expect(log.find((c) => c.by === "ear")?.ask).toBe("audio/mpeg en");
    const vision = log.filter((c) => c.by === "eye");
    expect(vision).toHaveLength(1);
    expect(vision[0]?.images).toBe(2);

    const md = renderWatched(w);
    expect(md).toContain(
      "## Speech\n\nhello from the fixture\n\n## On screen\n\n[0:00] caption 0:00\n[0:02] caption 0:02\n\n## Cuts\n\n",
    );
    expect(md).toContain(cutsLine(w));
  }, 30_000);

  it("skips the transcription when the caller has the words, or gave no ear", async () => {
    const { eye, ear, log } = fakes();
    expect((await watchFile(video, { eye, ear, speech: false })).speech).toBe("");
    expect((await watchFile(video, { eye })).speech).toBe("");
    expect(log.some((c) => c.by === "ear")).toBe(false);
  }, 30_000);

  it("adds the video model's read of the whole file, sent inline as video", async () => {
    const { eye, video: whole, log } = fakes();
    const g = await watchFile(video, { eye, video: whole });
    expect(g.whole).toBe("[0:00:01] [visual] a slide");
    expect(renderWatched(g)).toContain("## On screen (whole video)\n\n[0:00:01] [visual] a slide");
    expect(log.find((c) => c.by === "video")?.media).toBe("video/mp4");
    expect(renderWatched(await watchFile(video, { eye, video: null }))).not.toContain(
      "whole video",
    );
  }, 30_000);

  it("says what it could not open, and refuses a video model that takes no video", async () => {
    const { eye } = fakes();
    await expect(watchFile(join(dir, "missing.mp4"), { eye })).rejects.toThrow(
      /ffprobe could not read it/,
    );
    const blind = modelOf({ ...eye, takes: new Set(["text", "image"] as const) });
    await expect(watchFile(video, { eye, video: blind })).rejects.toThrow(/takes no video/);
  });

  it("leaves no work directory behind", async () => {
    // A temp folder of its own: the shared one holds other runs' work directories.
    const own = await mkdtemp(join(tmpdir(), "watch-test-own-"));
    const was = process.env.TMPDIR;
    process.env.TMPDIR = own;
    try {
      const { eye, ear } = fakes();
      await watchFile(video, { eye, ear });
      expect(await readdir(own)).toEqual([]);
    } finally {
      if (was === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = was;
      await rm(own, { recursive: true, force: true });
    }
  }, 30_000);
});
