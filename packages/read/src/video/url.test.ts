import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeModel, gemini } from "@wrenautomation/models";
import { fakeEar } from "@wrenautomation/models/hear";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { flatPlaylist } from "./list.js";
import { readAudio, readVideo, readYoutubeByUrl } from "./url.js";

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("youtube by URL", () => {
  it("reads speech and screen, clips in order, meta from oEmbed", async () => {
    const oembed = (async () =>
      Response.json({
        title: "Cold email in 2026",
        author_name: "Synth Channel",
      })) as unknown as typeof fetch;
    const asked: string[] = [];
    // The real Gemini model over a faked wire: each clip's offsets must reach the body.
    const wire = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      asked.push(url);
      const body = JSON.parse(String(init?.body)) as {
        contents: { parts: { videoMetadata?: { startOffset: string }; text?: string }[] }[];
      };
      const parts = body.contents[0]?.parts ?? [];
      const start = parts[0]?.videoMetadata?.startOffset ?? "?";
      const speech = parts[1]?.text?.startsWith("Transcribe the speech");
      return Response.json({
        candidates: [
          {
            content: { role: "model", parts: [{ text: speech ? `said ${start}` : "none" }] },
            finishReason: "STOP",
          },
        ],
      });
    }) as unknown as typeof fetch;
    const r = await readYoutubeByUrl("https://youtu.be/abcdefghijk", {
      model: gemini({ key: "k-0000000001", fetch: wire }),
      fetchFn: oembed,
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
    expect(asked[0]).toMatch(/^https:\/\/generativelanguage\.googleapis\.com\/.*:generateContent/);
  });

  it("refuses what is not a YouTube video", async () => {
    await expect(
      readYoutubeByUrl("https://example.com/x", { model: fakeModel("none") }),
    ).rejects.toThrow(/not a YouTube video/);
  });
});

describe.skipIf(!hasFfmpeg)("audio", () => {
  it("cuts an episode into clips and keeps their order and times", async () => {
    const dir = await mkdtemp(join(tmpdir(), "read-url-audio-test-"));
    try {
      const file = join(dir, "tone.ogg");
      execFileSync("ffmpeg", [
        ...["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=f=440:d=3"],
        ...["-ac", "1", "-c:a", "libopus", "-b:a", "8k", file],
      ]);
      const audio = await readFile(file);
      const asks: string[] = [];
      const fetchFn = (async () => new Response(audio)) as unknown as typeof fetch;
      const model = fakeModel((ask, req) => {
        const parts = typeof req.prompt === "string" ? [] : req.prompt;
        expect(parts[0]).toMatchObject({ type: "audio", mediaType: "audio/ogg" });
        const at = /clip starts at ([\d:]+)/.exec(ask)?.[1] ?? "?";
        asks.push(at);
        return `heard ${at}`;
      });
      const r = await readAudio("https://cdn.example.com/ep1.mp3", {
        url: "https://show.example/ep1",
        title: "Episode one",
        creator: "Synth Show",
        model,
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

/** The eye, faked: one on-screen line per frame time asked. */
const eye = fakeModel((ask) =>
  (/Their times: ([^.]+)\./.exec(ask)?.[1] ?? "")
    .split(", ")
    .filter(Boolean)
    .map((t) => `[${t}] caption ${t}`)
    .join("\n"),
);

describe.skipIf(!hasFfmpeg)("other video", () => {
  let dir = "";
  let video = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "read-url-test-"));
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
      eye,
      ear: fakeEar("hello from the fixture"),
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
    const dir = await mkdtemp(join(tmpdir(), "read-list-test-"));
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
