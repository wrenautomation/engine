import { readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// Vitest keeps transformed modules in <tmpdir>/<21-char nanoid>/ssr and removes the dir only on a
// clean close; killed runs leave them behind. Each run removes leaks idle over an hour.
function pruneLeakedRuns(): void {
  const cutoff = Date.now() - 3_600_000;
  for (const root of new Set([tmpdir(), "/private/tmp"])) {
    let names: string[] = [];
    try {
      names = readdirSync(root).filter((n) => /^[\w-]{21}$/.test(n));
    } catch {}
    for (const name of names) {
      try {
        const dir = join(root, name);
        if (Math.max(statSync(dir).mtimeMs, statSync(join(dir, "ssr")).mtimeMs) < cutoff)
          rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  }
}
pruneLeakedRuns();
const PACKAGES = ["models", "raven", "falcon", "weaver", "orrery"];

// One run over every package. Only the sources: a build leaves compiled tests in dist/.
export default defineConfig({
  test: {
    testTimeout: 120_000,
    hookTimeout: 180_000,
    projects: PACKAGES.map((name) => ({
      extends: true,
      test: { name, root: `packages/${name}`, include: ["src/**/*.test.ts"] },
    })),
  },
});
