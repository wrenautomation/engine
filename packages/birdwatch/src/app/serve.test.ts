import { fakeModel } from "@wrenautomation/models";
import { describe, expect, it } from "vitest";
import { claimExtractor } from "../document/index.js";
import { add, open, planRound, search, type Who } from "../engine/agent.js";
import { type Deps, registry, type Source } from "../engine/ports.js";
import type { RunRow, RunView } from "../engine/view.js";
import { countingIds } from "../ledger/ids.js";
import { MemoryLedger } from "../ledger/memory.js";
import { defaultPlanFile } from "../engine/plan.js";
import { type Changes, serveApp } from "./serve.js";

const fake: Source = {
  name: "fake",
  kind: "both",
  cost: "free",
  search: async () => [
    { url: "https://a.example/one", title: "One" },
    { url: "https://a.example/two" },
  ],
  open: async (h) => ({ url: h.url, media: "text", text: `page ${h.url}` }),
};
const agent: Who = { from: "ai", by: "claude-code" };

async function setup() {
  let t = 0;
  const ledger = new MemoryLedger();
  const d: Deps = {
    sources: registry(fake),
    ledger,
    model: fakeModel(() => "{}", "m"),
    extractor: claimExtractor,
    clock: () => new Date(Date.UTC(2026, 9, 28, 10, 0, ++t)),
    ids: countingIds(),
    writer: "claude-code",
  };
  const { run } = await planRound(d, {
    ask: { text: "repeat clients", kind: "web" },
    planFile: { ...defaultPlanFile("web"), sources: ["fake"] },
    model: "m",
  });
  const searched = await search(d, run, [{ terms: "a", why: "the ask's words" }], agent);
  const [one, two] = searched.wrote.flatMap((r) => (r.type === "hit" ? [r.id] : []));
  if (!one || !two) throw new Error("two hits");
  await add(d, run, { type: "call", on: two, verdict: "drop", why: "thin" }, agent);
  await open(d, run, { hits: [one], why: "numbers" }, agent);
  const subs = new Set<(run: string) => void>();
  const changes: Changes = (on) => {
    subs.add(on);
    return () => subs.delete(on);
  };
  const app = serveApp({ deps: d, runs: async () => [run, "empty"], changes });
  return {
    d,
    run,
    one,
    two,
    app,
    changed: (r: string) => {
      for (const s of subs) s(r);
    },
  };
}

describe("birdwatch serve", () => {
  it("lists runs, sends a run's view and a page's text", async () => {
    const { run, one, two, app } = await setup();
    const list = (await (await app.request("/runs")).json()) as { runs: RunRow[] };
    expect(list.runs).toHaveLength(1);
    expect(list.runs[0]).toMatchObject({ run, ask: "repeat clients", hits: 2, documents: 1 });

    const view = (await (await app.request(`/runs/${run}`)).json()) as RunView;
    expect(view.v).toBe(1);
    const [q] = view.queries;
    expect(q?.hits).toEqual([one, two]);
    const hit = view.hits.find((h) => h.id === two);
    expect(hit?.call).toMatchObject({ verdict: "drop", why: "thin", by: "claude-code" });
    const doc = view.documents[0];
    expect(doc).toMatchObject({ hit: one, url: "https://a.example/one" });
    expect(view.hits.find((h) => h.id === one)?.document).toBe(doc?.id);
    expect(view.timeline.map((m) => m.type)).toEqual(
      expect.arrayContaining(["snapshot", "query", "call", "done"]),
    );

    const page = await (await app.request(`/runs/${run}/documents/${doc?.id}`)).json();
    expect(page).toMatchObject({
      url: "https://a.example/one",
      text: "page https://a.example/one",
    });
    expect((await app.request(`/runs/${run}/documents/nope`)).status).toBe(404);
    expect((await app.request("/runs/nope")).status).toBe(404);
  });

  it("keeps a view until its run changes", async () => {
    const { d, run, one, app, changed } = await setup();
    const first = (await (await app.request(`/runs/${run}`)).json()) as RunView;
    await add(d, run, { type: "call", on: one, verdict: "keep", why: "numbers" }, agent);
    const cached = (await (await app.request(`/runs/${run}`)).json()) as RunView;
    expect(cached.timeline).toHaveLength(first.timeline.length);
    changed(run);
    const fresh = (await (await app.request(`/runs/${run}`)).json()) as RunView;
    expect(fresh.timeline).toHaveLength(first.timeline.length + 1);
  });

  it("answers the portal and localhost, a private-network preflight too; no one else", async () => {
    const { app } = await setup();
    const pre = await app.request("/runs", {
      method: "OPTIONS",
      headers: {
        origin: "https://app.wrenautomation.com",
        "access-control-request-method": "GET",
        "access-control-request-private-network": "true",
      },
    });
    expect(pre.headers.get("access-control-allow-origin")).toBe("https://app.wrenautomation.com");
    expect(pre.headers.get("access-control-allow-private-network")).toBe("true");
    const dev = await app.request("/runs", { headers: { origin: "http://localhost:5173" } });
    expect(dev.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    const other = await app.request("/runs", { headers: { origin: "https://evil.example" } });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("streams one event per changed run", async () => {
    const { run, app, changed } = await setup();
    const stop = new AbortController();
    const res = await app.request("/events", { signal: stop.signal });
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");
    const text = new TextDecoder();
    let got = "";
    const read = async (until: string) => {
      while (!got.includes(until)) got += text.decode((await reader.read()).value);
    };
    await read("event: ping");
    changed(run);
    await read("event: run");
    expect(got).toContain(`data: {"run":"${run}"}`);
    stop.abort();
    await reader.cancel();
  });
});
