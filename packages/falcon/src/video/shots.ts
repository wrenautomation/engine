/**
 * Shot labels by vision (designs/2026-10-25-competitor-analyzer.md, Read): for each shot of a film,
 * frames at its start, middle and end, and one just before it starts, go to a vision model
 * (`cohereEye`), which picks the shot's type, camera move and way in from closed sets the caller gives.
 * An answer outside a set is null, never guessed. The caller decides which labels it trusts: a
 * label ships only once it matches a hand seed at 80% or better (`labelMatch`).
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isTransient, type Model } from "@wrenautomation/models";
import { runFor, TOOL_MS } from "./tools.js";

/** The labels asked, each with its closed set. */
export const LABELS = ["type", "move", "in"] as const;
export type Label = (typeof LABELS)[number];
export type LabelSets = Record<Label, readonly string[]>;
export type ShotLabels = Record<Label, string | null>;

/** A shot to label: its start and length in seconds. */
export interface ShotSpan {
  t: number;
  len: number;
}

/** Calls at a time: the vision model's per-minute limit refuses 3 at once on a film. */
const AT_ONCE = 1;
/** A per-minute cap with no `retry-after`: wait it out this long, at most `CAP_WAITS` times a shot. */
const CAP_WAIT_MS = 61_000;
const CAP_WAITS = 3;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** `fn`, again after the vendor's wait (a minute when it names none) each time it says "later". */
async function waitOutCap<T>(fn: () => Promise<T>, pause: (ms: number) => Promise<void>) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= CAP_WAITS || !isTransient(err)) throw err;
      const until = err.retryAfter ? Date.parse(err.retryAfter) - Date.now() : Number.NaN;
      await pause(Number.isNaN(until) ? CAP_WAIT_MS : Math.max(0, Math.min(until, CAP_WAIT_MS)));
    }
  }
}

/** Dark films read as nothing; this lifts the shadows before the model sees them. */
const BRIGHTEN = "eq=gamma=1.6:contrast=1.15";

const MEANS: Record<Label, string> = {
  type: "what the shot shows: ui (an app screen), b-roll (real-world footage), graphic (motion design, no app), logo, text-card (words alone on a plain ground), talking-head (a person speaking to camera)",
  move: "how the camera moves within the shot: static, push (in), pull (out), pan, track (slides along), orbit (circles the subject), roll (tilts the frame or the plane), rack-focus, macro (extreme close-up), ui-zoom (zooms into part of a screen)",
  in: "how the shot begins after the one before: cut, dissolve (the two overlap), fade (from or through black or white), whip (a fast blur)",
};

export const labelAsk = (sets: LabelSets, first: boolean) =>
  `These frames are from one shot of a produced product film, in order: ${first ? "its start" : "the last moment of the shot before it, then its start"}, its middle and its end. Label the shot.
${LABELS.map((l) => `- ${l}: ${MEANS[l]}. One of: ${sets[l].join(", ")}.`).join("\n")}
Answer JSON only: {${LABELS.map((l) => `"${l}": "..."`).join(", ")}}. Use null for a label you cannot tell.`;

/** The model's answer, held to the sets: an answer outside one is null. */
export function parseLabels(answer: string, sets: LabelSets): ShotLabels {
  const json = /\{[\s\S]*\}/.exec(answer)?.[0];
  let got: Record<string, unknown> = {};
  try {
    got = json ? (JSON.parse(json) as Record<string, unknown>) : {};
  } catch {
    got = {};
  }
  const pick = (l: Label) => {
    const v = typeof got[l] === "string" ? (got[l] as string).trim().toLowerCase() : null;
    return v && sets[l].includes(v) ? v : null;
  };
  return { type: pick("type"), move: pick("move"), in: pick("in") };
}

/** The frame times for a shot: just before it (not for the first), its start, middle and end. */
export function shotTimes(s: ShotSpan): number[] {
  const edge = Math.min(0.3, s.len * 0.15);
  const r = (x: number) => Math.round(x * 100) / 100;
  return [
    ...(s.t > 0 ? [r(Math.max(0, s.t - 0.2))] : []),
    r(s.t + edge),
    r(s.t + s.len / 2),
    r(s.t + s.len - edge),
  ];
}

async function frameAt(file: string, at: number, out: string, ffmpeg: string, bright: boolean) {
  const scale = "scale='if(gt(iw,ih),-2,360)':'if(gt(iw,ih),360,-2)'";
  await runFor(
    ffmpeg,
    [
      ...["-nostdin", "-hide_banner", "-loglevel", "error", "-ss", String(at), "-i", file, "-an"],
      ...["-frames:v", "1", "-vf", bright ? `${scale},${BRIGHTEN}` : scale, "-q:v", "4", out],
    ],
    TOOL_MS,
  );
  return readFile(out);
}

/**
 * Each shot's labels, one vision call a shot, `AT_ONCE` at a time. A shot whose call fails keeps
 * null labels and a warning; every call failing throws.
 */
export async function labelShots(
  file: string,
  shots: readonly ShotSpan[],
  sets: LabelSets,
  o: {
    /** Takes images (`cohereEye`). */
    eye: Model;
    ffmpeg?: string;
    bright?: boolean;
    /** For tests: stands in for the wait on a per-minute cap. */
    pause?: (ms: number) => Promise<void>;
  },
): Promise<ShotLabels[]> {
  const ffmpeg = o.ffmpeg ?? "ffmpeg";
  const dir = await mkdtemp(join(tmpdir(), "falcon-shots-"));
  const none: ShotLabels = { type: null, move: null, in: null };
  try {
    const out: ShotLabels[] = [];
    let failed = 0;
    for (let i = 0; i < shots.length; i += AT_ONCE) {
      const group = shots.slice(i, i + AT_ONCE);
      const done = await Promise.allSettled(
        group.map((s, j) => waitOutCap(() => labelOne(s, i + j), o.pause ?? sleep)),
      );
      for (const r of done) {
        if (r.status === "fulfilled") out.push(r.value);
        else {
          failed++;
          console.warn(`shot ${out.length + 1}: ${r.reason}; labels left empty`);
          out.push(none);
        }
      }
    }
    if (shots.length && failed === shots.length) throw new Error("every shot's label call failed");
    return out;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  async function labelOne(s: ShotSpan, n: number): Promise<ShotLabels> {
    const times = shotTimes(s);
    const jpegs = await Promise.all(
      times.map((at, k) => frameAt(file, at, join(dir, `${n}-${k}.jpg`), ffmpeg, o.bright ?? true)),
    );
    const { text } = await o.eye.complete({
      prompt: [
        { type: "text", text: labelAsk(sets, s.t <= 0) },
        ...jpegs.map((b) => ({ type: "image" as const, data: b, mediaType: "image/jpeg" })),
      ],
    });
    return parseLabels(text, sets);
  }
}

/** Each label's share of hand labels the machine matched; a hand label that is null is skipped. */
export function labelMatch(
  hand: readonly Partial<ShotLabels>[],
  machine: readonly ShotLabels[],
): Record<Label, { n: number; hits: number; share: number; misses: [string, string | null][] }> {
  return Object.fromEntries(
    LABELS.map((l) => {
      const pairs = hand.flatMap((h, i) =>
        h[l] ? [[h[l] as string, machine[i]?.[l] ?? null] as [string, string | null]] : [],
      );
      const hits = pairs.filter(([a, b]) => a === b).length;
      return [
        l,
        {
          n: pairs.length,
          hits,
          share: pairs.length ? hits / pairs.length : 0,
          misses: pairs.filter(([a, b]) => a !== b),
        },
      ];
    }),
  ) as never;
}
