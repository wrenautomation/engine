/**
 * weaver: the web in, documents out. Two doors: `./fetch` (polite HTTP, robots, the fetch ladder
 * up to a browser) and `./video` (YouTube, any other video and podcasts read from a URL through
 * yt-dlp and falcon; what a channel or search holds). What reads a file, bytes or text is
 * falcon's (`@wrenautomation/falcon`). The source interface, registry, runner and ledger come in
 * phase 3.5c of wren's `designs/2026-10-26-research-engine.md`.
 */
export * from "./fetch/index.js";
export * from "./video/index.js";
