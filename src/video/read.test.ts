import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { flatPlaylist } from "./list.js";
import { captionsBody, readAudio, readVideo, readYoutubeByUrl } from "./read.js";
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

describe("youtube by URL", () => {
  it("reads speech and screen, clips in order, meta from oEmbed", async () => {
    const asked: string[] = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("oembed"))
        return Response.json({ title: "Cold email in 2026", author_name: "Synth Channel" });
      asked.push(url);
      const body = JSON.parse(String(init?.body)) as {
        contents: { parts: { videoMetadata?: { startOffset: string }; text?: string }[] }[];
      };
      const parts = body.contents[0]?.parts ?? [];
      const start = parts[0]?.videoMetadata?.startOffset ?? "?";
      const speech = parts[1]?.text?.startsWith("Transcribe the speech");
      return Response.json({
        candidates: [{ content: { parts: [{ text: speech ? `said ${start}` : "none" }] } }],
      });
    }) as unknown as typeof fetch;
    const r = await readYoutubeByUrl("https://youtu.be/abcdefghijk", {
      geminiKeys: ["k"],
      fetchFn,
      durationS: 900,
    });
    expect(r).toMatchObject({
      kind: "youtube",
      id: "abcdefghijk",
      title: "Cold email in 2026",
      channel: "Synth Channel",
      url: "https://www.youtube.com/watch?v=abcdefghijk",
      duration: 900,
    });
    expect(r.body.indexOf("said 0s")).toBeLessThan(r.body.indexOf("said 600s"));
    expect(r.body).not.toContain("## On screen");
    expect(asked).toHaveLength(4);
    expect(asked[0]).toMatch(/^https:\/\/generativelanguage\.googleapis\.com\//);
  });

  it("refuses what is not a YouTube video", async () => {
    await expect(readYoutubeByUrl("https://example.com/x", { geminiKeys: ["k"] })).rejects.toThrow(
      /not a YouTube video/,
    );
  });
});

describe.skipIf(!hasFfmpeg)("audio", () => {
  it("cuts an episode into clips and keeps their order and times", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scribe-audio-test-"));
    try {
      const file = join(dir, "tone.ogg");
      execFileSync("ffmpeg", [
        ...["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=f=440:d=3"],
        ...["-ac", "1", "-c:a", "libopus", "-b:a", "8k", file],
      ]);
      const audio = await readFile(file);
      const asks: string[] = [];
      const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url === "https://cdn.example.com/ep1.mp3") return new Response(audio);
        const body = JSON.parse(String(init?.body)) as {
          contents: { parts: { inlineData?: { mimeType: string }; text?: string }[] }[];
        };
        const parts = body.contents[0]?.parts ?? [];
        expect(parts[0]?.inlineData?.mimeType).toBe("audio/ogg");
        const at = /clip starts at ([\d:]+)/.exec(parts[1]?.text ?? "")?.[1] ?? "?";
        asks.push(at);
        return Response.json({ candidates: [{ content: { parts: [{ text: `heard ${at}` }] } }] });
      }) as unknown as typeof fetch;
      const r = await readAudio("https://cdn.example.com/ep1.mp3", {
        url: "https://show.example/ep1",
        title: "Episode one",
        creator: "Synth Show",
        geminiKeys: ["k"],
        fetchFn,
        // Two-second clips of a three-second tone: a 700 s episode took minutes to encode and cut.
        clipS: 2,
      });
      expect(asks.sort()).toEqual(["0:00", "0:02"]);
      expect(r).toMatchObject({
        kind: "podcast",
        title: "Episode one",
        channel: "Synth Show",
        duration: 3,
      });
      expect(r.id).toMatch(/^[0-9a-f]{12}$/);
      expect(r.body.indexOf("heard 0:00")).toBeLessThan(r.body.indexOf("heard 0:02"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/** Cohere, faked: the speech and one on-screen line per frame time asked. */
const cohere = (async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = String(input);
  if (url.endsWith("/v2/audio/transcriptions"))
    return Response.json({ text: "hello from the fixture" });
  if (url.endsWith("/v2/chat")) {
    const body = JSON.parse(String(init.body)) as {
      messages: { content: { type: string; text?: string }[] }[];
    };
    const text = body.messages[0]?.content.find((p) => p.type === "text")?.text ?? "";
    const times = (/Their times: ([^.]+)\./.exec(text)?.[1] ?? "").split(", ").filter(Boolean);
    return Response.json({
      message: {
        content: [{ type: "text", text: times.map((t) => `[${t}] caption ${t}`).join("\n") }],
      },
    });
  }
  throw new Error(`unexpected ${url}`);
}) as unknown as typeof fetch;

describe.skipIf(!hasFfmpeg)("other video", () => {
  let dir = "";
  let video = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "scribe-read-test-"));
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

  it("reads a fetched reel: caption, then Speech, On screen and Cuts", async () => {
    // Stands in for yt-dlp: copies the fixture to the -o file and prints the info JSON.
    const fake = join(dir, "yt-dlp.mjs");
    await writeFile(
      fake,
      `import { copyFileSync } from "node:fs";
const a = process.argv.slice(2);
copyFileSync(${JSON.stringify(video)}, a[a.indexOf("-o") + 1].replace("%(ext)s", "mp4"));
console.log(JSON.stringify({ id: "abc", title: "Video by x", extractor_key: "Instagram", channel: "x", upload_date: "20261003", description: "Four things\\nmore", webpage_url: "https://www.instagram.com/reel/abc/" }));`,
    );
    const r = await readVideo("https://www.instagram.com/reel/abc/", {
      ytDlp: `node ${fake}`,
      cohereKeys: ["k1"],
      fetchFn: cohere,
      pause: async () => {},
    });
    expect(r).toMatchObject({
      kind: "instagram",
      id: "abc",
      title: "Four things",
      channel: "x",
      uploaded: "2026-10-03",
      url: "https://www.instagram.com/reel/abc/",
    });
    expect(r.body).toContain(
      "## Caption\n\nFour things\nmore\n\n## Speech\n\nhello from the fixture\n\n## On screen\n\n[0:00] caption 0:00",
    );
    expect(r.body).toMatch(/\n## Cuts\n\n\d:\d\d\.\d\n$/);
  }, 30_000);
});

describe("list", () => {
  it("is yt-dlp's flat playlist, entries with an id, the range as playlist bounds", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scribe-list-test-"));
    try {
      const fake = join(dir, "yt-dlp.mjs");
      await writeFile(
        fake,
        `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(join(dir, "argv.json"))}, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ entries: [{ id: "a", title: "A" }, { title: "no id" }, { id: "b", view_count: 5 }] }));`,
      );
      const entries = await flatPlaylist(`node ${fake}`, "ytsearch2:cold email", {
        start: 3,
        end: 4,
      });
      expect(entries).toEqual([
        { id: "a", title: "A" },
        { id: "b", view_count: 5 },
      ]);
      const argv = JSON.parse(await readFile(join(dir, "argv.json"), "utf8")) as string[];
      expect(argv).toEqual([
        ...[
          "-J",
          "--flat-playlist",
          "--no-warnings",
          "--playlist-start",
          "3",
          "--playlist-end",
          "4",
        ],
        "ytsearch2:cold email",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
