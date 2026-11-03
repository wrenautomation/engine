import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { dirStore } from "./store.js";

describe("dir store", () => {
  const dirs: string[] = [];
  afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

  it("keeps a file and its meta; past the cap the oldest goes first", async () => {
    const root = await mkdtemp(join(tmpdir(), "read-store-"));
    dirs.push(root);
    const src = join(root, "src.mp4");
    await writeFile(src, Buffer.alloc(600));
    const store = dirStore(join(root, "kept"), { maxBytes: 1000 });
    await store.put("instagram/old", src, { id: "old", title: "o" });
    const old = join(root, "kept", "instagram", "old.mp4");
    await utimes(old, new Date(0), new Date(0));
    await store.put("tiktok/new", src, { id: "new", title: "n" });
    expect(await readdir(join(root, "kept", "instagram"))).toEqual([]);
    const dest = join(root, "out.mp4");
    expect(await store.get("tiktok/new", dest)).toEqual({ id: "new", title: "n" });
    expect(await store.get("instagram/old", dest)).toBeNull();
  });
});
