/**
 * read: the web and files in, text out. Four doors: `./fetch` (polite HTTP, robots, the fetch
 * ladder up to a browser), `./text` (HTML and PDF to text, a page to title, text and links),
 * `./video` (a video or podcast from a URL or a file: captions, `watch`, audio to markdown, what a
 * channel or search holds) and `./study` (claims that must quote a page, drafts that must cite a
 * claim, the report). Every model call goes through `@wrenautomation/models`. No database here.
 */
export * from "./fetch/index.js";
export * from "./study/index.js";
export * from "./text/index.js";
export * from "./video/index.js";
