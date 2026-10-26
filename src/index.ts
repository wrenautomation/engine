/**
 * scribe: pages, files and videos in; text and quoted facts out. Four doors:
 * `./fetch` (polite HTTP, robots, HTML to text, a fetch ladder client), `./text` (HTML and
 * PDF to text), `./video` (watch a video with ffmpeg, Cohere and Gemini) and `./study`
 * (claims that must quote a page, drafts that must cite a claim, the report).
 */
export * from "./fetch/index.js";
export * from "./study/index.js";
export * from "./text/index.js";
export * from "./video/index.js";
