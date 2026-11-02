/**
 * The machine's config: which env files birdwatch reads its keys from, so an agent's shell
 * needs no wrapper. `~/.config/birdwatch/config.json` (or BIRDWATCH_CONFIG):
 * `{ "env": ["/path/llm.env"], "keys": ["EXA_API_KEY*", "RESTATE_AUTH_TOKEN"], "vars": { "RESTATE_INGRESS_URL": "https://restate.example.com" } }`.
 * `keys` limits what is taken (a trailing `*` takes a prefix; `A=B` takes B as A); absent, all.
 * A variable already set always wins. Values are never printed.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { z } from "zod";

const Config = z.object({
  env: z.array(z.string()).default([]),
  keys: z.array(z.string()).optional(),
  vars: z.record(z.string(), z.string()).default({}),
});

export const configPath = (env: NodeJS.ProcessEnv = process.env): string =>
  env.BIRDWATCH_CONFIG ?? join(homedir(), ".config", "birdwatch", "config.json");

/** What the config would set, from its text and a file reader. */
export function configVars(text: string, read: (file: string) => string): Record<string, string> {
  const c = Config.parse(JSON.parse(text));
  const all: Record<string, string> = {};
  for (const file of c.env) Object.assign(all, parseEnv(read(file)));
  const out: Record<string, string> = {};
  if (!c.keys) Object.assign(out, all);
  else
    for (const k of c.keys) {
      const [to, from] = k.includes("=") ? (k.split("=", 2) as [string, string]) : [k, k];
      if (from.endsWith("*")) {
        const p = from.slice(0, -1);
        for (const [n, v] of Object.entries(all))
          if (n.startsWith(p) && v !== undefined) out[n] = v;
      } else if (all[from] !== undefined) out[to] = all[from] as string;
    }
  return { ...out, ...c.vars };
}

/** Fills the env from the config, never over a set variable. The config's path, or null. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): string | null {
  const path = configPath(env);
  if (!existsSync(path)) return null;
  const vars = configVars(readFileSync(path, "utf8"), (f) => readFileSync(f, "utf8"));
  for (const [k, v] of Object.entries(vars)) if (env[k] === undefined) env[k] = v;
  return path;
}
