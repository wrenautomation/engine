/**
 * falcon: files, markup and media in; text and quoted facts out. Three doors: `./text` (HTML and
 * PDF to text, a page to title, text and links), `./video` (watch a video file with ffmpeg, Cohere
 * and Gemini; captions and audio to markdown) and `./study` (claims that must quote a page, drafts
 * that must cite a claim, the report). Fetching a page or a video is weaver's
 * (`@wrenautomation/weaver`).
 */
export * from "./study/index.js";
export * from "./text/index.js";
export * from "./video/index.js";
