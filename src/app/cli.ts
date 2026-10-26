#!/usr/bin/env node
/**
 * `scribe`: the library from a shell. `fetch <url>` prints a page as text, `text <file>`
 * an HTML or PDF file as text, `watch <video>` what a video shows and says.
 * Keys come from the environment: COHERE_API_KEY (or COHERE_API_KEY_1..n), GEMINI_API_KEY.
 */
import { readFile } from "node:fs/promises";
import { Command } from "commander";
import { PoliteFetcher, userAgent } from "../fetch/fetcher.js";
import { readPage } from "../fetch/htmltext.js";
import { htmlText, pdfText } from "../text/text.js";
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

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
