/**
 * Video on the web: the readers over a URL (`read.ts`: YouTube by captions or by URL, any other
 * video by yt-dlp plus falcon's `watch`, a podcast by its audio URL), `watch` over a URL or a
 * file, and the list reader (`list.ts`: what a profile, channel or search holds). The reading
 * itself is falcon's. Every caller passes its own keys and tools. No database here.
 */
export * from "./list.js";
export * from "./read.js";
