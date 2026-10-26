/**
 * Video: `watch` (ffmpeg facts, Cohere speech and on-screen text, Gemini when a key works), the
 * readers over it and over captions and audio (`read.ts`, one `VideoRead` shape), and the list
 * reader (`list.ts`). Every caller passes its own keys and tools. No database here.
 */
export * from "./gemini.js";
export * from "./list.js";
export * from "./read.js";
export * from "./shots.js";
export * from "./tools.js";
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
