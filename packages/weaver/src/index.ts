/**
 * weaver: the web in, documents out. Two doors: `./fetch` (polite HTTP, robots, the fetch ladder
 * up to a browser) and `./video` (YouTube, any other video and podcasts read from a URL through
 * yt-dlp and falcon; what a channel or search holds). What reads a file, bytes or text is
 * falcon's (`@wrenautomation/falcon`). Three more doors run the research engine (wren's
 * `designs/2026-10-26-research-engine.md`, 3.5c): `./engine` (the source port, registry, runner),
 * `./sources` (SearXNG, Exa, yt-dlp, the fetcher, the ladder, a paste, the ledger) and
 * `./ledger` (the records, a folder of JSON lines per run per writer, yield rows). The engine's
 * CLI commands (`addEngineCommands`) are on this root door, for a host that mounts them on its
 * own program. Every model call goes through `@wrenautomation/models`.
 */
export * from "./app/index.js";
export * from "./engine/index.js";
export * from "./fetch/index.js";
export * from "./ledger/index.js";
export * from "./sources/index.js";
export * from "./video/index.js";
