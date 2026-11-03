import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeModel, gemini } from "@wrenautomation/models";
import { fakeEar } from "@wrenautomation/models/hear";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { flatPlaylist } from "./list.js";
import { dirStore, mediaKey } from "./store.js";
import { CAPTION_WAITS_MS, readAudio, readVideo, readYoutube, readYoutubeByUrl } from "./url.js";

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
  it("takes the direct link before yt-dlp, keeps it, and reads it again from the store", async () => {
    const calls = join(dir, "calls.log");
    const fake = join(dir, "yt-dlp-count.mjs");
    await writeFile(
      fake,
      `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(calls)}, "yt-dlp\\n");
process.exit(1);`,
    );
    const bytes = await readFile(video);
    let fetched = 0;
    const cdn = (async () => {
      fetched++;
      return new Response(bytes, { headers: { "content-length": String(bytes.length) } });
    }) as unknown as typeof fetch;
    const store = dirStore(join(dir, "store"));
    const opts = {
      ytDlp: `node ${fake}`,
      eye,
      ear: fakeEar("from the link"),
      store,
      fetchFn: cdn,
      mediaUrl: "https://scontent.cdninstagram.com/v/abc.mp4?oe=1",
      meta: { description: "Graph caption", uploader: "acct", upload_date: "20261101" },
    };
    const url = "https://www.instagram.com/reel/DQx1abc/";
    const first = await readVideo(url, opts);
    expect(first).toMatchObject({
      kind: "instagram",
      id: "DQx1abc",
      title: "Graph caption",
      channel: "acct",
      uploaded: "2026-11-01",
    });
    expect(first.body).toContain("from the link");
    const second = await readVideo(url, { ...opts, mediaUrl: "https://gone.example/x.mp4" });
    expect(second.id).toBe("DQx1abc");
    expect(fetched).toBe(1);
    await expect(readFile(calls, "utf8")).rejects.toThrow();
  }, 30_000);

  it("falls back to yt-dlp when the link has expired", async () => {
    const fake = join(dir, "yt-dlp-fallback.mjs");
    await writeFile(
      fake,
      `import { copyFileSync } from "node:fs";
const a = process.argv.slice(2);
copyFileSync(${JSON.stringify(video)}, a[a.indexOf("-o") + 1].replace("%(ext)s", "mp4"));
console.log(JSON.stringify({ id: "Zz9", title: "t", extractor_key: "Instagram", webpage_url: "https://www.instagram.com/reel/Zz9/" }));`,
    );
    const warned: string[] = [];
    const r = await readVideo("https://www.instagram.com/reel/Zz9/", {
      ytDlp: `node ${fake}`,
      eye,
      fetchFn: (async () => new Response("expired", { status: 403 })) as unknown as typeof fetch,
      mediaUrl: "https://scontent.cdninstagram.com/v/old.mp4",
      warn: (l) => warned.push(l),
    });
    expect(r.id).toBe("Zz9");
    expect(warned.join()).toMatch(/media link failed \(HTTP 403\), yt-dlp instead/);
  }, 30_000);
});

describe("media key", () => {
  it("is the platform and the id from a page URL", () => {
    expect(mediaKey("https://www.youtube.com/watch?v=abcdefghijk&t=3")).toBe("youtube/abcdefghijk");
    expect(mediaKey("https://youtu.be/abcdefghijk")).toBe("youtube/abcdefghijk");
    expect(mediaKey("https://www.youtube.com/shorts/abcdefghijk")).toBe("youtube/abcdefghijk");
    expect(mediaKey("https://www.instagram.com/reel/DQx1abc/")).toBe("instagram/DQx1abc");
    expect(mediaKey("https://www.instagram.com/acct/reel/DQx1abc/")).toBe("instagram/DQx1abc");
    expect(mediaKey("https://www.instagram.com/p/DQx1abc/")).toBe("instagram/DQx1abc");
    expect(mediaKey("https://www.tiktok.com/@a/video/7312345678901234567")).toBe(
      "tiktok/7312345678901234567",
    );
    expect(mediaKey("https://x.com/a/status/1850000000000000000")).toBe("x/1850000000000000000");
    expect(mediaKey("https://example.com/v.mp4")).toBeNull();
    expect(mediaKey("not a url")).toBeNull();
  });
});

describe("youtube captions", () => {
  it("waits out a round of 429s, then reads the next track", async () => {
    const dir = await mkdtemp(join(tmpdir(), "read-yt-test-"));
    try {
      const fake = join(dir, "yt-dlp.mjs");
      const tracks = [1, 2, 3, 4].map((i) => ({ ext: "json3", url: `https://cap.example/${i}` }));
      await writeFile(
        fake,
        `console.log(JSON.stringify(${JSON.stringify({ id: "abcdefghijk", title: "T", duration: 5, automatic_captions: { en: tracks } })}));`,
      );
      const asked: string[] = [];
      const fetchFn = (async (u: string) => {
        asked.push(u);
        return u.endsWith("/4")
          ? Response.json({ events: [{ tStartMs: 0, segs: [{ utf8: "hello" }] }] })
          : new Response("", { status: 429 });
      }) as unknown as typeof fetch;
      const waits: number[] = [];
      const r = await readYoutube("https://www.youtube.com/watch?v=abcdefghijk", {
        ytDlp: `node ${fake}`,
        fetchFn,
        pause: async (ms) => {
          waits.push(ms);
        },
      });
      expect(asked.map((u) => u.slice(-1))).toEqual(["1", "2", "3", "4"]);
      expect(waits).toEqual([CAPTION_WAITS_MS[0]]);
      expect(r.body).toContain("hello");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
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
