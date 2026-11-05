/**
 * `birdwatch serve`: ledgers read over HTTP for a viewer. JSON for the run list, a run's view,
 * a page's text and the map of every run; a server-sent event per run each time its records change.
 * Read only, on 127.0.0.1, for the origins named (the portal, any localhost): the CLI stays the one
 * writer. More than one ledger: each run is read with its own folder's deps (its yield, its baselines).
 */
import { watch } from "node:fs";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { mapOf, type ResearchMap } from "../engine/map.js";
import type { Deps } from "../engine/ports.js";
import { fold, type RunState } from "../engine/state.js";
import { type RunRow, type RunView, rowOf, runView } from "../engine/view.js";

export const SERVE_PORT = 4747;
export const SERVE_ORIGINS = ["https://app.wrenautomation.com"];
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/** A run whose records changed: from a folder watch, or a test. */
export type Changes = (on: (run: string) => void) => () => void;

/** One ledger folder: its name on the map, its deps, its runs. */
export interface LedgerSet {
  group: string;
  deps: Deps;
  runs: () => Promise<string[]>;
}

/** A ledger root's name on the map: its last two folders ("11-05/editing-survey"). */
export const groupOf = (root: string) =>
  root.replace(/\/+$/, "").split(/[\\/]/).slice(-2).join("/");

/** Changes from many watches as one. */
export const allChanges =
  (...all: Changes[]): Changes =>
  (on) => {
    const offs = all.map((c) => c(on));
    return () => {
      for (const off of offs) off();
    };
  };

/** Changes under `<root>/runs/<run>/`, one call per run per burst. */
export function watchRuns(root: string): Changes {
  const subs = new Set<(run: string) => void>();
  const due = new Map<string, NodeJS.Timeout>();
  watch(`${root}/runs`, { recursive: true }, (_e, file) => {
    const run = file?.toString().split(/[\\/]/)[0];
    if (!run) return;
    clearTimeout(due.get(run));
    due.set(
      run,
      setTimeout(() => {
        due.delete(run);
        for (const s of subs) s(run);
      }, 150),
    );
  }).unref();
  return (on) => {
    subs.add(on);
    return () => subs.delete(on);
  };
}

export function serveApp(o: {
  sets: readonly LedgerSet[];
  changes: Changes;
  origins?: readonly string[];
}): Hono {
  const origins = new Set(o.origins ?? SERVE_ORIGINS);
  const [first] = o.sets;
  if (!first) throw new Error("serve: no ledger");
  const views = new Map<string, Promise<RunView>>();
  const states = new Map<string, Promise<RunState | null>>();
  const owner = new Map<string, LedgerSet>();
  let map: Promise<ResearchMap> | null = null;
  o.changes((run) => {
    views.delete(run);
    states.delete(run);
    map = null;
  });
  const cached = <T>(m: Map<string, Promise<T>>, run: string, make: () => Promise<T>) => {
    let v = m.get(run);
    if (!v) {
      v = make();
      v.catch(() => m.delete(run));
      m.set(run, v);
    }
    return v;
  };
  /** Every run, each with the set that holds it; the first set wins a name two hold. */
  const all = async () => {
    const lists = await Promise.all(o.sets.map(async (s) => ({ s, runs: await s.runs() })));
    const out: { run: string; set: LedgerSet }[] = [];
    for (const { s, runs } of lists)
      for (const run of runs)
        if (!owner.has(run) || owner.get(run) === s) {
          owner.set(run, s);
          out.push({ run, set: s });
        }
    return out;
  };
  const setOf = async (run: string) => {
    if (!owner.has(run) && o.sets.length > 1) await all();
    return owner.get(run) ?? first;
  };
  const viewOf = (run: string) =>
    cached(views, run, async () => runView((await setOf(run)).deps, run));
  const stateOf = (run: string) =>
    cached(states, run, async () => {
      const records = await (await setOf(run)).deps.ledger.trace(run);
      return records.length ? fold(run, records) : null;
    });
  const app = new Hono();
  // A public page asking a private address: Chrome's preflight wants this yes.
  app.use(async (c, next) => {
    await next();
    if (c.req.header("access-control-request-private-network"))
      c.res.headers.set("access-control-allow-private-network", "true");
  });
  app.use(
    cors({
      origin: (origin) => (origins.has(origin) || LOCAL.test(origin) ? origin : null),
      allowMethods: ["GET"],
    }),
  );
  app.onError((err, c) =>
    c.json({ error: err.message }, /no records/.test(err.message) ? 404 : 500),
  );

  app.get("/runs", async (c) => {
    const rows = await Promise.all(
      (await all()).map(async ({ run }) => {
        const st = await stateOf(run);
        return st ? rowOf(st) : null;
      }),
    );
    const list = rows.filter((r): r is RunRow => r !== null);
    return c.json({ v: 1, runs: list.sort((a, b) => b.updated.localeCompare(a.updated)) });
  });
  app.get("/runs/:run", async (c) => c.json(await viewOf(c.req.param("run"))));
  app.get("/runs/:run/documents/:doc", async (c) => {
    const run = c.req.param("run");
    const records = await (await setOf(run)).deps.ledger.trace(run);
    const d = records.find((r) => r.type === "document" && r.id === c.req.param("doc"));
    if (d?.type !== "document") return c.json({ error: "no such document" }, 404);
    return c.json({ id: d.id, url: d.url, title: d.title ?? null, media: d.media, text: d.text });
  });
  app.use("/map", compress());
  // Every run as one map, positions fixed by the records (engine/map.ts).
  app.get("/map", async (c) => {
    map ??= all().then(async (runs) => {
      const got = await Promise.all(
        runs.map(async ({ run, set }) => ({ group: set.group, state: await stateOf(run) })),
      );
      return mapOf(got.flatMap((g) => (g.state ? [{ group: g.group, state: g.state }] : [])));
    });
    map.catch(() => {
      map = null;
    });
    return c.json(await map);
  });
  // One event per changed run; the viewer fetches what it shows again.
  app.get("/events", (c) =>
    streamSSE(c, async (stream) => {
      const off = o.changes((run) => {
        void stream.writeSSE({ event: "run", data: JSON.stringify({ run }) });
      });
      stream.onAbort(off);
      while (!stream.aborted) {
        await stream.writeSSE({ event: "ping", data: "" });
        await stream.sleep(25_000);
      }
      off();
    }),
  );
  return app;
}
