#!/usr/bin/env node
// One version for every package: set it, commit, push main, tag on GitHub. The tag publishes (release.yml).
// `pnpm release [patch|minor|<version>]`. The version is a claim, not a lock: the next free one past
// every v* tag and the local version. Lost race (push refused, tag taken): merge, take the next, again.
// Shared checkout: only package.json files must be clean; commits go through peers; the tag through the
// GitHub API (an SSH tag push hangs). `--next`: print the version it would take.
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmdirSync } from "node:fs";
import { join } from "node:path";

const REPO = "wrenautomation/engine";
const TRIES = 5;
const LOCK = join(process.env.TMPDIR ?? "/tmp", "engine-release.lock");
const arg = process.argv[2] ?? "patch";

const run = (cmd, args, o = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...o }).trim();
const tryRun = (cmd, args) => {
  try {
    return { ok: true, out: run(cmd, args) };
  } catch (err) {
    return { ok: false, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
};

const parse = (v) => v.replace(/^v/, "").split(".").map(Number);
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const bump = ([x, y, z], kind) =>
  kind === "minor" ? [x, y + 1, 0] : kind === "major" ? [x + 1, 0, 0] : [x, y, z + 1];
const str = (v) => v.join(".");

const files = [
  "package.json",
  ...readdirSync("packages").map((p) => join("packages", p, "package.json")),
].filter((f) => tryRun("git", ["ls-files", "--error-unmatch", f]).ok);

function next() {
  const local = parse(JSON.parse(run("cat", ["package.json"])).version);
  const tags = run("gh", [
    "api",
    "--paginate",
    `repos/${REPO}/git/matching-refs/tags/v`,
    "--jq",
    ".[].ref",
  ])
    .split("\n")
    .filter((r) => /^refs\/tags\/v\d+\.\d+\.\d+$/.test(r))
    .map((r) => parse(r.slice("refs/tags/".length)));
  const top = [local, ...tags].sort(cmp).at(-1);
  if (/^\d+\.\d+\.\d+$/.test(arg)) {
    const want = parse(arg);
    return cmp(want, top) > 0 ? want : bump(top, "patch");
  }
  return bump(top, arg);
}

/** Main moved elsewhere: merge it (package.json conflicts are ours to retake: theirs wins, we bump past). */
function catchUp() {
  run("git", ["fetch", "-q", "origin", "main"]);
  if (tryRun("git", ["merge-base", "--is-ancestor", "origin/main", "HEAD"]).ok) return;
  const m = tryRun("git", ["merge", "--no-edit", "origin/main"]);
  if (m.ok) return;
  const conflicted = run("git", ["diff", "--name-only", "--diff-filter=U"])
    .split("\n")
    .filter(Boolean);
  if (conflicted.every((f) => files.includes(f))) {
    run("git", ["checkout", "--theirs", "--", ...conflicted]);
    run("git", ["add", "--", ...conflicted]);
    run("git", ["commit", "-q", "--no-edit"]);
    return;
  }
  run("git", ["merge", "--abort"]);
  throw new Error(`merge of origin/main conflicts beyond package.json: ${conflicted.join(", ")}`);
}

if (arg === "--next") {
  console.log(str(next()));
  process.exit(0);
}
let done = false;
try {
  mkdirSync(LOCK);
} catch {
  console.error(`another release is running (${LOCK}); wait for it`);
  process.exit(1);
}
try {
  if (
    !tryRun("git", ["diff", "--quiet", "--", ...files]).ok ||
    !tryRun("git", ["diff", "--cached", "--quiet", "--", ...files]).ok
  )
    throw new Error("a package.json has uncommitted changes");
  for (let i = 1; i <= TRIES; i++) {
    catchUp();
    const v = str(next());
    for (const f of files)
      run("npm", ["pkg", "set", `version=${v}`], {
        cwd: f.replace(/\/?package\.json$/, "") || ".",
      });
    const peers = tryRun("sh", ["-c", "command -v peers"]).ok;
    if (peers) run("peers", ["commit", "-m", `v${v}`, ...files]);
    else run("git", ["commit", "-q", "-m", `v${v}`, "--", ...files]);
    if (!tryRun("git", ["push", "-q", "origin", "HEAD:main"]).ok) {
      console.error(`v${v}: main moved, try ${i + 1}`);
      continue;
    }
    const sha = run("git", ["rev-parse", "HEAD"]);
    const tag = tryRun("gh", [
      "api",
      `repos/${REPO}/git/refs`,
      "-f",
      `ref=refs/tags/v${v}`,
      "-f",
      `sha=${sha}`,
      "--jq",
      ".ref",
    ]);
    if (!tag.ok) {
      if (/Reference already exists/i.test(tag.out)) {
        console.error(`v${v}: tag taken, try ${i + 1}`);
        continue;
      }
      throw new Error(`tag v${v}: ${tag.out}`);
    }
    console.log(`released v${v}: main pushed, tag made; release.yml publishes`);
    done = true;
    break;
  }
  if (!done) throw new Error(`no free version after ${TRIES} tries`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  rmdirSync(LOCK);
}
