#!/usr/bin/env node
/**
 * `weaver`: the library from a shell. `fetch <url>` prints a page as text, `read <url>` a video
 * as one markdown document, `list <target>` what a profile, channel or search holds. A file on
 * disk is falcon's (`npx falcon text|page|watch`). Keys come from the environment:
 * COHERE_API_KEY (or COHERE_API_KEY_1..n), GEMINI_API_KEY. The engine's commands (`run`,
 * `trace`, `keep`, `drop`, `yield`, `sources`) are in `engine-cli.ts`.
 */
import { readPage } from "@wrenautomation/falcon/text";
import type { VideoRead } from "@wrenautomation/falcon/video";
import { Command } from "commander";
import { PoliteFetcher, userAgent } from "../fetch/fetcher.js";
import { flatPlaylist } from "../video/list.js";
import { readVideo, readYoutube } from "../video/read.js";
import { addEngineCommands, keys } from "./engine-cli.js";

const program = new Command()
  .name("weaver")
  .description("pages and videos on the web as text; the research engine's runner and ledger");

program
  .command("fetch <url>")
  .description("a page as text (polite: one request at a time per host, a contact in the UA)")
  .option(
    "--contact <who>",
    "an email address or URL a site operator could reach you at (sent in the User-Agent)",
    process.env.WEAVER_CONTACT,
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
    const geminiKeys = keys(process.env, "GEMINI_API_KEY");
    let read: VideoRead;
    if (/^https?:\/\/(www\.|m\.)?(youtube\.com|youtu\.be)\//.test(url))
      read = await readYoutube(url, { ytDlp: o.ytDlp, geminiKeys });
    else {
      const cohereKeys = keys(process.env, "COHERE_API_KEY");
      if (!cohereKeys.length)
        throw new Error("read needs COHERE_API_KEY for a video with no captions");
      read = await readVideo(url, { ytDlp: o.ytDlp, ffmpeg: o.ffmpeg, cohereKeys, geminiKeys });
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

addEngineCommands(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
