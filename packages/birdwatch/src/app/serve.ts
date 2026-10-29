/**
 * `birdwatch serve`: a ledger read over HTTP for a viewer. JSON for the run list, a run's view and
 * a page's text; a server-sent event per run each time its records change. Read only, on
 * 127.0.0.1, for the origins named (the portal, any localhost): the CLI stays the one writer.
 */
import { watch } from "node:fs";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import type { Deps } from "../engine/ports.js";
import { fold } from "../engine/state.js";
import { type RunRow, type RunView, rowOf, runView } from "../engine/view.js";

export const SERVE_PORT = 4747;
export const SERVE_ORIGINS = ["https://app.wrenautomation.com"];
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/** A run whose records changed: from a folder watch, or a test. */
export type Changes = (on: (run: string) => void) => () => void;

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
  deps: Deps;
  runs: () => Promise<string[]>;
  changes: Changes;
  origins?: readonly string[];
}): Hono {
  const origins = new Set(o.origins ?? SERVE_ORIGINS);
  const views = new Map<string, Promise<RunView>>();
  const rows = new Map<string, Promise<RunRow | null>>();
  o.changes((run) => {
    views.delete(run);
    rows.delete(run);
  });
  const viewOf = (run: string) => {
    let v = views.get(run);
    if (!v) {
      v = runView(o.deps, run);
      v.catch(() => views.delete(run));
      views.set(run, v);
    }
    return v;
  };
  const rowFor = (run: string) => {
    let r = rows.get(run);
    if (!r) {
      r = o.deps.ledger
        .trace(run)
        .then((records) => (records.length ? rowOf(fold(run, records)) : null));
      r.catch(() => rows.delete(run));
      rows.set(run, r);
    }
    return r;
  };

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
    const all = await Promise.all((await o.runs()).map(rowFor));
    const list = all.filter((r): r is RunRow => r !== null);
    return c.json({ v: 1, runs: list.sort((a, b) => b.updated.localeCompare(a.updated)) });
  });
  app.get("/runs/:run", async (c) => c.json(await viewOf(c.req.param("run"))));
  app.get("/runs/:run/documents/:doc", async (c) => {
    const records = await o.deps.ledger.trace(c.req.param("run"));
    const d = records.find((r) => r.type === "document" && r.id === c.req.param("doc"));
    if (d?.type !== "document") return c.json({ error: "no such document" }, 404);
    return c.json({ id: d.id, url: d.url, title: d.title ?? null, media: d.media, text: d.text });
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
