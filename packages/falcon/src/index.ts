/**
 * falcon: files, markup and media in; text and quoted facts out. Four doors: `./text` (HTML and
 * PDF to text, a page to title, text and links), `./video` (watch a video file with ffmpeg and
 * models; captions and audio to markdown), `./study` (claims that must quote a page, drafts
 * that must cite a claim, the report) and `./document` (the research engine's `Document`,
 * `Finding` and `Proof`, readers by media, the claim extractor). Fetching a page or a video is
 * weaver's (`@wrenautomation/weaver`).
 */
export * from "./document/index.js";
export * from "./study/index.js";
export * from "./text/index.js";
export * from "./video/index.js";
