#!/usr/bin/env node
/**
 * `scribe`: the library from a shell. `fetch <url>` prints a page as text, `text <file>`
 * an HTML or PDF file as text, `watch <video>` what a video shows and says, `read <url>` a
 * video as one markdown document, `list <target>` what a profile, channel or search holds.
 * Keys come from the environment: COHERE_API_KEY (or COHERE_API_KEY_1..n), GEMINI_API_KEY.
 */
import { readFile } from "node:fs/promises";
import { Command } from "commander";
import { PoliteFetcher, userAgent } from "../fetch/fetcher.js";
import { readPage } from "../fetch/htmltext.js";
import { htmlText, pdfText } from "../text/text.js";
import { flatPlaylist } from "../video/list.js";
import { readVideo, readYoutube, type VideoRead } from "../video/read.js";
import { frameCounts, renderWatched, watch } from "../video/watch.js";

/** `NAME`, then `NAME_1`, `NAME_2`, ... in order: a fleet of keys for one vendor. */
function keys(env: NodeJS.ProcessEnv, name: string): string[] {
  const out: string[] = [];
  const one = env[name];
  if (one) out.push(one);
  for (let i = 1; ; i++) {
    const k = env[`${name}_${i}`];
    if (!k) break;
    out.push(k);
  }
  return out;
}

const program = new Command().name("scribe").description("pages, files and videos as text");

program
  .command("fetch <url>")
  .description("one page as text, with its links")
  .requiredOption(
    "--contact <who>",
    "an email address or URL a site operator could reach you at (sent in the User-Agent)",
    process.env.SCRIBE_CONTACT,
  )
  .option("--json", "title, text, links, mailtos and tels as JSON")
  .action(async (url: string, o: { contact: string; json?: boolean }) => {
    const fetcher = new PoliteFetcher(userAgent(o.contact));
    const res = await fetcher.get(url);
    const page = readPage(res.text, res.url);
    if (o.json) console.log(JSON.stringify({ status: res.status, url: res.url, ...page }, null, 2));
    else console.log(page.title ? `${page.title}\n\n${page.text}` : page.text);
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

interface WatchFlags {
  json?: boolean;
  speech: boolean;
  language: string;
  every: number;
  ffmpeg: string;
  ytDlp: string;
}

program
  .command("watch <video>")
  .description("a video's speech, on-screen text and cuts (a file, or a URL with --yt-dlp)")
  .option("--json", "the result as JSON")
  .option("--no-speech", "skip the transcription")
  .option("--language <code>", "spoken language, ISO 639-1", "en")
  .option("--every <s>", "seconds between frames", Number, 2)
  .option("--ffmpeg <path>", "the ffmpeg binary", "ffmpeg")
  .option("--yt-dlp <cmd>", "the yt-dlp command, for a URL", "yt-dlp")
  .action(async (input: string, o: WatchFlags) => {
    const cohereKeys = keys(process.env, "COHERE_API_KEY");
    if (!cohereKeys.length) throw new Error("watch needs COHERE_API_KEY");
    const watched = await watch(input, {
      cohereKeys,
      geminiKeys: keys(process.env, "GEMINI_API_KEY"),
      ffmpeg: o.ffmpeg,
      ytDlp: o.ytDlp,
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

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
