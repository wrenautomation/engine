import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  cohereCall,
  cutsLine,
  frameCounts,
  onScreenLines,
  parseScenes,
  readScreen,
  readWatchFacts,
  renderWatched,
  type Watched,
  watch,
} from "./index.js";

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const noPause = async () => {};

/** What a vision call asked: its text, and how many pictures came with it. */
const asked = (init: RequestInit) => {
  const body = JSON.parse(String(init.body)) as {
    model: string;
    messages: { content: { type: string; text?: string }[] }[];
  };
  const parts = body.messages[0]?.content ?? [];
  return {
    model: body.model,
    text: parts.find((p) => p.type === "text")?.text ?? "",
    images: parts.filter((p) => p.type === "image_url").length,
  };
};
/** The frame times a vision ask lists. */
const timesIn = (text: string) =>
  (/Their times: ([^.]+)\./.exec(text)?.[1] ?? "").split(", ").filter(Boolean);

const shots = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ at: i * 2, jpeg: Buffer.from(`frame${i}`) }));

const chatAnswer = (text: string) =>
  Response.json({ message: { content: [{ type: "text", text }] } });

describe("readScreen", () => {
  it("tags each line with its frame time; a frame with no line stays not read, never filled", async () => {
    const calls: string[] = [];
    const fetchFn = (async (_url: string, init: RequestInit) => {
      const q = asked(init);
      calls.push(q.text);
      expect(q.model).toBe("command-a-vision-07-2025");
      expect(q.images).toBe(8);
      // The model drops the frame at 0:06 and sees no text at 0:08.
      return chatAnswer(
        timesIn(q.text)
          .filter((t) => t !== "0:06")
          .map((t) => `[${t}] ${t === "0:08" ? "none" : `text at ${t}`}`)
          .join("\n"),
      );
    }) as unknown as typeof fetch;
    const frames = await readScreen(shots(8), ["k"], { fetchFn, pause: noPause });
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
    const fetchFn = (async (_url: string, init: RequestInit) => {
      const times = timesIn(asked(init).text);
      batches.push(times);
      return chatAnswer(times.map((t) => `[${t}] t${t}`).join("\n"));
    }) as unknown as typeof fetch;
    const frames = await readScreen(shots(11), ["k"], { fetchFn, pause: noPause });
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
    const fetchFn = (async (_url: string, init: RequestInit) => {
      const q = asked(init);
      asks.push(q.text);
      return asks.length === 1
        ? chatAnswer("I can't assist with describing images of people.")
        : chatAnswer(
            timesIn(q.text)
              .map((t) => `[${t}] says ${t}`)
              .join("\n"),
          );
    }) as unknown as typeof fetch;
    const frames = await readScreen(shots(3), ["k"], { fetchFn, pause: noPause });
    expect(asks).toHaveLength(2);
    expect(asks[0]).not.toContain("Ignore people");
    expect(asks[1]).toContain("Read only on-screen text, UI and graphics. Ignore people.");
    expect(frames.map((f) => f.text)).toEqual(["says 0:00", "says 0:02", "says 0:04"]);
  });

  it("a frame refused in a line is asked again; one the first answer read keeps its line", async () => {
    const asks: string[] = [];
    const fetchFn = (async (_url: string, init: RequestInit) => {
      const q = asked(init);
      asks.push(q.text);
      return asks.length === 1
        ? chatAnswer(
            "[0:00] SALE 50%\n[0:02] I'm sorry, I can't describe images of people.\n[0:04] none",
          )
        : chatAnswer("[0:00] changed\n[0:02] a title card\n[0:04] changed");
    }) as unknown as typeof fetch;
    const frames = await readScreen(shots(3), ["k"], { fetchFn, pause: noPause });
    expect(asks).toHaveLength(2);
    expect(frames.map((f) => f.text)).toEqual(["SALE 50%", "a title card", ""]);
  });

  it("a frame still refused after the retry is not read, and a batch is asked twice at most", async () => {
    let n = 0;
    const fetchFn = (async () => {
      n++;
      return chatAnswer("I'm sorry, but I can't help with that.");
    }) as unknown as typeof fetch;
    const frames = await readScreen(shots(2), ["k"], { fetchFn, pause: noPause });
    expect(n).toBe(2);
    expect(frames).toEqual([
      { at: 0, text: null },
      { at: 2, text: null },
    ]);
  });

  it("an unasked batch leaves its frames not read; all of them failing throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const sent: string[] = [];
      const half = (async (_url: string, init: RequestInit) => {
        const q = asked(init);
        sent.push(q.text);
        if (q.text.includes("0:00,"))
          return chatAnswer(
            timesIn(q.text)
              .map((t) => `[${t}] ok`)
              .join("\n"),
          );
        return new Response("bad request", { status: 400 });
      }) as unknown as typeof fetch;
      const frames = await readScreen(shots(10), ["k"], { fetchFn: half, pause: noPause });
      expect(frames.slice(0, 8).every((f) => f.text === "ok")).toBe(true);
      expect(frames.slice(8)).toEqual([
        { at: 16, text: null },
        { at: 18, text: null },
      ]);
      const none = (async () =>
        new Response("bad request", { status: 400 })) as unknown as typeof fetch;
      await expect(readScreen(shots(2), ["k"], { fetchFn: none, pause: noPause })).rejects.toThrow(
        /cohere vision 0:00: HTTP 400/,
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe("cohereCall", () => {
  it("hands a refused key's call to the next, and never puts a key in an error", async () => {
    const used: string[] = [];
    const fetchFn = (async (_url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>).authorization as string;
      used.push(auth);
      return used.length === 1 ? new Response("{}", { status: 429 }) : Response.json({ ok: true });
    }) as unknown as typeof fetch;
    const r = await cohereCall<{ ok: boolean }>(
      ["key-a", "key-b"],
      "/v2/chat",
      {},
      {
        fetchFn,
        pause: noPause,
      },
    );
    expect(r.ok).toBe(true);
    expect(new Set(used).size).toBe(2);
    const dead = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
    const err = await cohereCall(
      ["key-a", "key-b"],
      "/v2/chat",
      {},
      { fetchFn: dead, pause: noPause },
    ).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/every try refused, last HTTP 401/);
    expect((err as Error).message).not.toMatch(/key-[ab]/);
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

describe.skipIf(!hasFfmpeg)("watch", () => {
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

  /** Cohere and Gemini, faked: every call is logged. */
  const fakes = (gemini: "dead" | "live" | "none" = "none") => {
    const log: { url: string; auth: string; body: unknown }[] = [];
    const fetchFn = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      const headers = (init.headers ?? {}) as Record<string, string>;
      log.push({
        url,
        auth: headers.authorization ?? headers["x-goog-api-key"] ?? "",
        body: init.body,
      });
      if (url.endsWith("/v2/audio/transcriptions"))
        return Response.json({ text: "hello from the fixture" });
      if (url.endsWith("/v2/chat"))
        return chatAnswer(
          timesIn(asked(init).text)
            .map((t) => `[${t}] caption ${t}`)
            .join("\n"),
        );
      if (url.includes("/v1beta/models?"))
        return new Response("{}", { status: gemini === "live" ? 200 : 403 });
      if (url.includes(":generateContent"))
        return Response.json({
          candidates: [{ content: { parts: [{ text: "[0:00:01] [visual] a slide" }] } }],
        });
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch;
    return { fetchFn, log };
  };

  it("reads a file: ffmpeg facts, Cohere speech and screen, every line on its frame time", async () => {
    const { fetchFn, log } = fakes();
    const w = await watch(video, { cohereKeys: ["k1"], fetchFn, pause: noPause });
    expect(w.durationS).toBeGreaterThan(3.5);
    expect(w.durationS).toBeLessThan(4.5);
    expect(w.speech).toBe("hello from the fixture");
    expect(w.cuts).toHaveLength(1);
    expect(w.cuts[0]).toBeGreaterThan(1.8);
    expect(w.cuts[0]).toBeLessThan(2.2);
    expect(w.frames.map((f) => f.at)).toEqual([0, 2]);
    expect(w.frames.map((f) => f.text)).toEqual(["caption 0:00", "caption 0:02"]);
    expect(w.gemini).toBeUndefined();

    const speech = log.find((c) => c.url.endsWith("/v2/audio/transcriptions"));
    const form = speech?.body as FormData;
    expect(form.get("model")).toBe("cohere-transcribe-03-2026");
    expect(form.get("language")).toBe("en");
    expect((form.get("file") as File).size).toBeGreaterThan(1000);
    expect(speech?.auth).toBe("Bearer k1");
    const vision = log.filter((c) => c.url.endsWith("/v2/chat"));
    expect(vision).toHaveLength(1);
    const parts =
      (
        JSON.parse(String(vision[0]?.body)) as {
          messages: { content: { type: string; image_url?: { url: string } }[] }[];
        }
      ).messages[0]?.content ?? [];
    expect(parts[0]?.type).toBe("text");
    const images = parts.filter((p) => p.type === "image_url");
    expect(images).toHaveLength(2);
    expect(images[0]?.image_url?.url).toMatch(/^data:image\/jpeg;base64,/);

    const md = renderWatched(w);
    expect(md).toContain(
      "## Speech\n\nhello from the fixture\n\n## On screen\n\n[0:00] caption 0:00\n[0:02] caption 0:02\n\n## Cuts\n\n",
    );
    expect(md).toContain(cutsLine(w));
  }, 30_000);

  it("skips the transcription when the caller has the words", async () => {
    const { fetchFn, log } = fakes();
    const w = await watch(video, { cohereKeys: ["k1"], fetchFn, pause: noPause, speech: false });
    expect(w.speech).toBe("");
    expect(log.some((c) => c.url.includes("transcriptions"))).toBe(false);
  }, 30_000);

  it("skips Gemini without an error when no key works, and adds its screen when one does", async () => {
    const dead = fakes("dead");
    const w = await watch(video, {
      cohereKeys: ["k1"],
      geminiKeys: ["g1"],
      fetchFn: dead.fetchFn,
      pause: noPause,
    });
    expect(w.gemini).toBeUndefined();
    expect(dead.log.some((c) => c.url.includes(":generateContent"))).toBe(false);
    expect(renderWatched(w)).not.toContain("Gemini");

    const live = fakes("live");
    const g = await watch(video, {
      cohereKeys: ["k1"],
      geminiKeys: ["g1"],
      fetchFn: live.fetchFn,
      pause: noPause,
    });
    expect(g.gemini).toBe("[0:00:01] [visual] a slide");
    expect(renderWatched(g)).toContain("## On screen (Gemini)\n\n[0:00:01] [visual] a slide");
    const ask = live.log.find((c) => c.url.includes(":generateContent"));
    expect(String(ask?.body)).toContain("inlineData");
  }, 30_000);

  it("says what it could not open", async () => {
    await expect(watch(join(dir, "missing.mp4"), { cohereKeys: ["k1"] })).rejects.toThrow(
      /ffprobe could not read it/,
    );
    await expect(watch(video, { cohereKeys: [] })).rejects.toThrow(/needs COHERE keys/);
  });

  it("leaves no work directory behind", async () => {
    const mine = async () => (await readdir(tmpdir())).filter((n) => n.startsWith("watch-"));
    const before = new Set(await mine());
    const { fetchFn } = fakes();
    await watch(video, { cohereKeys: ["k1"], fetchFn, pause: noPause });
    expect((await mine()).filter((n) => !before.has(n))).toEqual([]);
  }, 30_000);
});
