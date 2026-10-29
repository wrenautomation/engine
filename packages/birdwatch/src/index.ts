/**
 * birdwatch: research from the open web, driven by an agent one step per command, every record
 * in a ledger. Five doors: `./engine` (the ask and plan files, the source port, registry, run
 * state, the steps and the agent commands), `./sources` (SearXNG, Exa, Google, arXiv, yt-dlp, the
 * site readers, the fetcher, the ladder, a paste, the ledger), `./ledger` (the records, a folder of
 * JSON lines per run per writer, yield rows), `./document` (`Document`, `Finding`, `Proof`, readers
 * by media, the claim extractor) and this root (the engine's CLI commands, `addEngineCommands`,
 * for a host that mounts them on its own program). Reading the web and files is
 * `@wrenautomation/read`'s; every model call goes through `@wrenautomation/models`. Design: wren's
 * `designs/2026-10-26-research-engine.md`.
 */
export * from "./app/index.js";
export * from "./engine/index.js";
export * from "./ledger/index.js";
export * from "./sources/index.js";
