/**
 * Video: `watchFile` (ffmpeg facts; an ear for the speech, an eye for the frames, a video model
 * when one is given) over a file on disk; the `VideoRead` shape with the captions renderer and the
 * audio hearer (`read.ts`); the readers over a URL (`url.ts`: YouTube by captions or by URL, any
 * other video by yt-dlp, a podcast by its audio URL, `watch` over a URL or a file); the list
 * reader (`list.ts`: what a profile, channel or search holds). Every caller passes its own models
 * and tools. No database here.
 */
export * from "./gemini.js";
export * from "./list.js";
export * from "./read.js";
export * from "./shots.js";
export * from "./tools.js";
export * from "./url.js";
export * from "./watch.js";

/** What `yt-dlp -J` prints; only what the readers use. */
export interface VideoInfo {
  id: string;
  title: string;
  channel?: string;
  upload_date?: string;
  webpage_url?: string;
  duration?: number;
  /** Its thumbnail's address. */
  thumbnail?: string;
  chapters?: { start_time: number; end_time: number; title: string }[] | null;
  subtitles?: Record<string, { ext: string; url: string }[]>;
  automatic_captions?: Record<string, { ext: string; url: string }[]>;
}
