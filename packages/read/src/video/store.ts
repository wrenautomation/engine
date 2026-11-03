/**
 * Fetched videos kept by `<platform>/<id>`, so a video downloads once. The port is two calls;
 * `dirStore` is the Mac's (a folder, oldest out past a size cap), a server brings its own
 * (wren: the media bucket's `cache/` prefix).
 */
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { VideoMeta } from "./url.js";

export interface MediaStore {
  /** The kept file copied to `dest`, with its meta; null when none is kept. */
  get(key: string, dest: string): Promise<VideoMeta | null>;
  put(key: string, file: string, info: VideoMeta): Promise<void>;
}

/** `instagram/DQx1abc`: the platform and the video's id from its page URL; null when unknown. */
export function mediaKey(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^(www|m)\./, "");
  const path = u.pathname;
  const youtube =
    host === "youtube.com"
      ? (u.searchParams.get("v") ?? /^\/(?:shorts|live)\/([\w-]{11})/.exec(path)?.[1])
      : host === "youtu.be"
        ? /^\/([\w-]{11})/.exec(path)?.[1]
        : undefined;
  if (youtube) return `youtube/${youtube}`;
  const ig =
    host === "instagram.com" && /^\/(?:[\w.]+\/)?(?:reels?|p|tv)\/([\w-]+)/.exec(path)?.[1];
  if (ig) return `instagram/${ig}`;
  const tiktok = host.endsWith("tiktok.com") && /\/video\/(\d+)/.exec(path)?.[1];
  if (tiktok) return `tiktok/${tiktok}`;
  const x = (host === "x.com" || host === "twitter.com") && /\/status\/(\d+)/.exec(path)?.[1];
  if (x) return `x/${x}`;
  return null;
}

/** 5 GB: about 700 reels at 540p. */
const DIR_MAX_BYTES = 5 * 1024 ** 3;

/** A folder of `<key>.mp4` and `<key>.json`; past `maxBytes` the least recently kept go first. */
export function dirStore(root: string, o: { maxBytes?: number } = {}): MediaStore {
  const max = o.maxBytes ?? DIR_MAX_BYTES;
  const prune = async () => {
    const files: { path: string; bytes: number; at: number }[] = [];
    for (const platform of await readdir(root).catch(() => [] as string[]))
      for (const name of await readdir(join(root, platform)).catch(() => [] as string[])) {
        if (!name.endsWith(".mp4")) continue;
        const path = join(root, platform, name);
        const s = await stat(path).catch(() => null);
        if (s) files.push({ path, bytes: s.size, at: s.mtimeMs });
      }
    let total = files.reduce((n, f) => n + f.bytes, 0);
    for (const f of files.sort((a, b) => a.at - b.at)) {
      if (total <= max) break;
      await rm(f.path, { force: true });
      await rm(f.path.replace(/\.mp4$/, ".json"), { force: true });
      total -= f.bytes;
    }
  };
  return {
    async get(key, dest) {
      const base = join(root, key);
      const info = await readFile(`${base}.json`, "utf8").catch(() => null);
      if (info === null) return null;
      try {
        await copyFile(`${base}.mp4`, dest);
      } catch {
        return null;
      }
      return JSON.parse(info) as VideoMeta;
    },
    async put(key, file, info) {
      const base = join(root, key);
      await mkdir(dirname(base), { recursive: true });
      await copyFile(file, `${base}.mp4`);
      await writeFile(`${base}.json`, JSON.stringify(info));
      await prune();
    },
  };
}
