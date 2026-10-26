/**
 * What a profile, channel or search holds, through yt-dlp's playlist view: titles, ids and
 * counts, no downloads. The list reader beside the piece readers in `read.ts`.
 */
import { runFor } from "./tools.js";

/** One entry of yt-dlp's playlist view (`--flat-playlist`): a TikTok profile, a YouTube search. */
export interface YtDlpEntry {
  id?: string;
  url?: string;
  webpage_url?: string;
  title?: string;
  description?: string;
  timestamp?: number;
  duration?: number;
  uploader?: string;
  channel?: string;
  thumbnails?: { url?: string }[];
  view_count?: number;
  like_count?: number;
  comment_count?: number;
}

const LIST_MS = 180_000;

/**
 * yt-dlp's playlist view of `target` (a profile, a channel's videos, `ytsearchN:<words>`), no
 * downloads: the entries with an id, in yt-dlp's order. `range` is 1-based and inclusive. Some
 * sites answer only a home IP. `ytDlp` is the command, split on spaces (`uvx yt-dlp`).
 */
export async function flatPlaylist(
  ytDlp: string,
  target: string,
  range?: { start: number; end: number },
): Promise<YtDlpEntry[]> {
  const [cmd, ...pre] = ytDlp.split(/\s+/) as [string, ...string[]];
  const { stdout } = await runFor(
    cmd,
    [
      ...pre,
      ...["-J", "--flat-playlist", "--no-warnings"],
      ...(range
        ? ["--playlist-start", String(range.start), "--playlist-end", String(range.end)]
        : []),
      target,
    ],
    LIST_MS,
    { maxBuffer: 64 * 1024 * 1024 },
  );
  return ((JSON.parse(stdout) as { entries?: YtDlpEntry[] }).entries ?? []).filter((e) => e.id);
}
