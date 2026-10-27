#!/usr/bin/env node
/**
 * `falcon`: the library from a shell. `text <file>` prints an HTML or PDF file as text,
 * `page <file>` an HTML file's title, text and links, `watch <video>` what a video file shows
 * and says. A URL is weaver's (`npx weaver fetch|read|list`). Keys come from the environment:
 * COHERE_API_KEY (or COHERE_API_KEY_1..n), GEMINI_API_KEY.
 */
import { readFile } from "node:fs/promises";
import { Command } from "commander";
import { readPage } from "../text/htmltext.js";
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

const program = new Command().name("falcon").description("files and videos as text");

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
    const watched = await watch(input, {
      cohereKeys,
      geminiKeys: keys(process.env, "GEMINI_API_KEY"),
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

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
