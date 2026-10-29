#!/usr/bin/env node
/**
 * `birdwatch`: the engine and its readers from a shell. The readers: `fetch <url>` prints a page
 * as text, `read <url>` a video as one markdown document, `list <target>` what a profile, channel
 * or search holds, `text <file>` an HTML or PDF file as text, `page <file>` an HTML file's title,
 * text and links, `watch <video>` what a video file shows and says. `plans [kind]` prints a stock
 * plan file to tune. Keys come from the environment: COHERE_API_KEY (or COHERE_API_KEY_1..n),
 * GEMINI_API_KEY. The engine's commands are in `engine-cli.ts`: the agent's (`plan`, `search`,
 * `open`, `extract`, `check`, `add`, `brief`), the plan file's (`learn`) and
 * the ledger's (`trace`, `yield`, `sources`). A person's word goes through `add ... --human`.
 */
import { readFile } from "node:fs/promises";
import { PoliteFetcher, userAgent } from "@wrenautomation/read/fetch";
import { htmlText, pdfText, readPage } from "@wrenautomation/read/text";
import {
  cohereEye,
  cohereSpeech,
  flatPlaylist,
  frameCounts,
  geminiVideo,
  readVideo,
  readYoutube,
  renderWatched,
  type VideoRead,
  watchFile,
} from "@wrenautomation/read/video";
import { Command } from "commander";
import { AskKind, defaultPlanFile, PLAN_KINDS } from "../engine/plan.js";
import { addEngineCommands, keys } from "./engine-cli.js";

const program = new Command()
  .name("birdwatch")
  .description("research from the open web: the engine's steps, its ledger, and its readers");

program
  .command("fetch <url>")
  .description("a page as text (polite: one request at a time per host, a contact in the UA)")
  .option(
    "--contact <who>",
    "an email address or URL a site operator could reach you at (sent in the User-Agent)",
    process.env.BIRDWATCH_CONTACT,
  )
  .option("--json", "title, text, links, mailtos and tels as JSON")
  .action(async (url: string, o: { contact: string; json?: boolean }) => {
    const fetcher = new PoliteFetcher(userAgent(o.contact));
    const res = await fetcher.get(url);
    const page = readPage(res.text, res.url);
    if (o.json) console.log(JSON.stringify({ status: res.status, url: res.url, ...page }, null, 2));
    else console.log(page.title ? `${page.title}\n\n${page.text}` : page.text);
  });

/** The read as one markdown document: its facts as front matter, its title, its sections. */
export function renderRead(r: VideoRead): string {
  const facts: [string, string | number | undefined][] = [
    ["source", `${r.kind}:${r.id}`],
    ["title", r.title],
    ["url", r.url],
    ["channel", r.channel],
    ["uploaded", r.uploaded],
    ["duration", r.duration],
    ["thumbnail", r.thumbnail],
  ];
  const front = facts
    .filter((f): f is [string, string | number] => f[1] !== undefined)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? JSON.stringify(v) : v}`)
    .join("\n");
  return `---\n${front}\n---\n\n# ${r.title}\n\n${r.body}`;
}

program
  .command("read <url>")
  .description(
    "a video as one markdown document: YouTube from its captions (plus the screen with GEMINI_API_KEY), any other video by watching it (COHERE_API_KEY)",
  )
  .option("--json", "the read as JSON")
  .option("--ffmpeg <path>", "the ffmpeg binary", "ffmpeg")
  .option("--yt-dlp <cmd>", "the yt-dlp command", "yt-dlp")
  .action(async (url: string, o: { json?: boolean; ffmpeg: string; ytDlp: string }) => {
    const video = await geminiVideo(keys(process.env, "GEMINI_API_KEY"));
    let read: VideoRead;
    if (/^https?:\/\/(www\.|m\.)?(youtube\.com|youtu\.be)\//.test(url))
      read = await readYoutube(url, { ytDlp: o.ytDlp, video });
    else {
      const cohereKeys = keys(process.env, "COHERE_API_KEY");
      if (!cohereKeys.length)
        throw new Error("read needs COHERE_API_KEY for a video with no captions");
      read = await readVideo(url, {
        ytDlp: o.ytDlp,
        ffmpeg: o.ffmpeg,
        eye: cohereEye(cohereKeys),
        ear: cohereSpeech(cohereKeys),
        video,
      });
    }
    console.log(o.json ? JSON.stringify(read, null, 2) : renderRead(read));
  });

program
  .command("list <target>")
  .description(
    "what a profile, channel or search (ytsearch10:<words>) holds, as JSON, no downloads",
  )
  .option("--from <n>", "first entry, 1-based", Number)
  .option("--to <n>", "last entry, inclusive", Number)
  .option("--yt-dlp <cmd>", "the yt-dlp command", "yt-dlp")
  .action(async (target: string, o: { from?: number; to?: number; ytDlp: string }) => {
    const range =
      o.from || o.to ? { start: o.from ?? 1, end: o.to ?? Number.MAX_SAFE_INTEGER } : undefined;
    console.log(JSON.stringify(await flatPlaylist(o.ytDlp, target, range), null, 2));
  });

program
  .command("text <file>")
  .description("an HTML or PDF file as text")
  .action(async (file: string) => {
    const bytes = await readFile(file);
    const out = /\.pdf$/i.test(file) ? await pdfText(bytes) : htmlText(bytes.toString("utf8"));
    if (out === null) throw new Error(`${file}: no text (scanned, encrypted or broken)`);
    console.log(out);
  });

program
  .command("page <file>")
  .description("an HTML file's title, text, links, mailtos and tels as JSON")
  .option("--url <url>", "the page's address, to resolve its links")
  .action(async (file: string, o: { url?: string }) => {
    const html = await readFile(file, "utf8");
    console.log(JSON.stringify(readPage(html, o.url ?? `file://${file}`), null, 2));
  });

interface WatchFlags {
  json?: boolean;
  speech: boolean;
  language: string;
  every: number;
  ffmpeg: string;
}

program
  .command("watch <video>")
  .description("a video file's speech, on-screen text and cuts")
  .option("--json", "the result as JSON")
  .option("--no-speech", "skip the transcription")
  .option("--language <code>", "spoken language, ISO 639-1", "en")
  .option("--every <s>", "seconds between frames", Number, 2)
  .option("--ffmpeg <path>", "the ffmpeg binary", "ffmpeg")
  .action(async (input: string, o: WatchFlags) => {
    const cohereKeys = keys(process.env, "COHERE_API_KEY");
    if (!cohereKeys.length) throw new Error("watch needs COHERE_API_KEY");
    const watched = await watchFile(input, {
      eye: cohereEye(cohereKeys),
      ear: cohereSpeech(cohereKeys),
      video: await geminiVideo(keys(process.env, "GEMINI_API_KEY")),
      ffmpeg: o.ffmpeg,
      speech: o.speech,
      language: o.language,
      everyS: o.every,
    });
    if (o.json) console.log(JSON.stringify(watched, null, 2));
    else console.log(renderWatched(watched));
    const { read, unread } = frameCounts(watched);
    console.error(
      `${watched.durationS}s, ${read} frames read, ${unread} not read, ${watched.cuts.length} cuts, ${watched.speech.length} chars of speech`,
    );
  });

program
  .command("plans [kind]")
  .description("a stock plan file to copy and tune; no kind lists them all")
  .action((kind?: string) => {
    const print = (x: unknown) => console.log(JSON.stringify(x, null, 2));
    if (kind) print(defaultPlanFile(AskKind.parse(kind)));
    else print(PLAN_KINDS.map((k) => defaultPlanFile(k)));
  });

addEngineCommands(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
