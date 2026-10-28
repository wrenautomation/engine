/**
 * A video or podcast read as one markdown document: the `VideoRead` shape, the captions renderer
 * (a YouTube json3 track to a heading per chapter) and the audio hearer (a file cut by ffmpeg into
 * clips, each transcribed by a model that takes audio). Everything here takes text or a file on
 * disk; fetching the captions or the audio is weaver's (`@wrenautomation/weaver/video`). Every
 * caller passes its own models and tools. Nothing here touches a database.
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Model } from "@wrenautomation/models";
import { readMedia } from "./gemini.js";
import type { VideoInfo } from "./index.js";
import { clock, run } from "./tools.js";

/** What a reader gives back: where the piece is, and its markdown sections. */
export interface VideoRead {
  /** The platform, lower case: `youtube`, `instagram`, `tiktok`, `podcast` (yt-dlp's extractor key). */
  kind: string;
  /** Its id on the platform; a podcast's is a hash of its audio URL. */
  id: string;
  title: string;
  url: string;
  channel?: string;
  /** YYYY-MM-DD. */
  uploaded?: string;
  /** Seconds, rounded. */
  duration?: number;
  thumbnail?: string;
  /** The sections as markdown, headings at `##`: one per chapter, or Caption, Speech, On screen, Cuts. */
  body: string;
}

/** YouTube's json3 caption track; only what is read. */
export interface Json3 {
  events: { tStartMs: number; segs?: { utf8: string }[] }[];
}

const MARK_EVERY_S = 60;
/** Seconds of video per model call. */
export const CLIP_S = 600;

/** yt-dlp's `YYYYMMDD` as an ISO date. */
export const isoDate = (d: string | undefined): string | undefined =>
  d?.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");

/** A model's "none": nothing shown or said. */
export const real = (s: string) => s && s.toLowerCase() !== "none";

/** Captions as markdown: a heading per chapter, a `[m:ss]` marker every minute so a reader can cite a moment. */
export function captionsBody(info: VideoInfo, track: Json3): string {
  const chapters = info.chapters?.length
    ? info.chapters
    : [{ start_time: 0, end_time: info.duration ?? Number.POSITIVE_INFINITY, title: info.title }];
  const words = track.events
    .filter((e) => e.segs?.length)
    .map((e) => ({
      t: e.tStartMs / 1000,
      text: (e.segs ?? [])
        .map((s) => s.utf8)
        .join("")
        .replace(/\s+/g, " ")
        .trim(),
    }))
    .filter((w) => w.text);
  return chapters
    .map((c) => {
      const lines: string[] = [];
      let mark = Number.NEGATIVE_INFINITY;
      for (const w of words) {
        if (w.t < c.start_time || w.t >= c.end_time) continue;
        if (w.t - mark >= MARK_EVERY_S) {
          mark = w.t;
          lines.push(`\n[${clock(w.t)}]`);
        }
        lines.push(w.text);
      }
      return `## [${clock(c.start_time)}] ${c.title}\n${lines.join(" ").trim()}\n`;
    })
    .join("\n");
}

const HEARD = (start: number) =>
  `Transcribe the speech in this podcast audio: every word spoken, in paragraphs, each starting with its time in the episode as [m:ss], or [h:mm:ss] past the hour (this clip starts at ${clock(start)}), and the speaker's name in bold when it's known. Fix only obvious mishearings. Leave out ad reads. Markdown, no heading. If nobody speaks, reply with the single word none.`;

/**
 * A podcast episode heard from its audio file on disk: cut by ffmpeg into `CLIP_S` mono clips
 * small enough to send inline (about 2 MB each), each transcribed by `model` (`geminiVideo`), 4 at
 * a time, times running on across clips. The clips are written beside the file and left for the
 * caller's cleanup. `label` names the calls in errors.
 */
export async function hearAudio(
  file: string,
  opts: {
    /** Takes audio: Gemini reads speakers and times where a plain transcriber gives words. */
    model: Model;
    ffmpeg?: string;
    /** Seconds per clip; `CLIP_S` unless a test cuts a short tone. */
    clipS?: number;
    label?: string;
  },
): Promise<{ speech: string; duration: number }> {
  if (!opts.model.takes.has("audio")) throw new Error(`${file}: ${opts.model.id} takes no audio`);
  const clipS = opts.clipS ?? CLIP_S;
  const ffmpeg = opts.ffmpeg ?? "ffmpeg";
  const label = opts.label ?? file;
  const dir = dirname(file);
  await run(
    ffmpeg,
    [
      ...["-hide_banner", "-loglevel", "error", "-i", file, "-vn", "-ac", "1", "-ar", "16000"],
      ...["-c:a", "libopus", "-b:a", "24k", "-f", "segment", "-segment_time", String(clipS)],
      ...["-reset_timestamps", "1", join(dir, "clip%03d.ogg")],
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  const clips = (await readdir(dir)).filter((f) => f.startsWith("clip")).sort();
  if (!clips.length) throw new Error(`${file}: ffmpeg cut no clips`);
  const hear = async (clip: string, i: number) => {
    const at = `${label} ${clock(i * clipS)} speech`;
    const said = await readMedia(
      opts.model,
      [{ type: "audio", data: await readFile(join(dir, clip)), mediaType: "audio/ogg" }],
      HEARD(i * clipS),
    ).catch((err: unknown) => {
      throw new Error(`${at}: ${err instanceof Error ? err.message : err}`, { cause: err });
    });
    return real(said) ? said : "";
  };
  const speech: string[] = [];
  for (let i = 0; i < clips.length; i += 4)
    speech.push(...(await Promise.all(clips.slice(i, i + 4).map((f, j) => hear(f, i + j)))));
  const { stdout } = await run(ffmpeg.replace(/ffmpeg$/, "ffprobe"), [
    ...["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
  ]).catch(() => ({ stdout: "" }));
  return {
    speech: `## Speech\n\n${speech.filter(Boolean).join("\n\n") || "(no speech)"}\n`,
    duration: Math.round(Number(stdout.trim()) || 0),
  };
}
