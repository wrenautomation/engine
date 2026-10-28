/**
 * The fetch ladder as an open source: `web GET /fetch` on a site client, up to a browser. Only
 * worth a call after the plain fetcher came back empty or blocked, so it sits after `fetcher` in
 * a plan file's sources. Browser cost. `httpLadderClient` is the wire to an autobrowse worker
 * for a terminal run: `GET $url/api/sites/web/fetch?url=&from=` with a bearer token.
 */
import { defaultReaders, type Media, type Reader } from "@wrenautomation/falcon/document";
import type { Source } from "../engine/ports.js";
import { Transient } from "../engine/transient.js";
import { fetchLadder, type LadderClient, type LadderTier } from "../fetch/ladder.js";

export function ladderSource(o: {
  sites: LadderClient;
  from?: LadderTier;
  readers?: Map<Media, Reader>;
}): Source {
  const readers = o.readers ?? defaultReaders();
  return {
    name: "ladder",
    kind: "open",
    cost: "browser",
    async open(h) {
      if (!/^https?:/.test(h.url)) return null;
      const r = await fetchLadder(o.sites, h.url, o.from ?? "impersonate");
      // offline: the worker did not answer, worth another try. cap: the day's bucket is spent.
      if ("failed" in r) {
        if (r.failed === "offline") throw new Transient("ladder: offline");
        throw new Error(`ladder: ${r.failed}`);
      }
      if (r.fetched.block)
        throw new Error(`ladder: blocked (${r.fetched.block}) at ${r.fetched.tier}`);
      const html = readers.get("html");
      if (!html) return null;
      return html.read({
        url: r.fetched.finalUrl || h.url,
        text: r.fetched.html,
        ...(h.title ? { title: h.title } : {}),
      });
    },
  };
}

export class LadderCallError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "LadderCallError";
  }
}

/** The HTTP wire to an autobrowse worker, enough for the ladder. wren has the whole client. */
export function httpLadderClient(o: {
  url: string;
  token?: string | null;
  fetchFn?: typeof fetch;
}): LadderClient {
  const fetchFn = o.fetchFn ?? fetch;
  const base = o.url.replace(/\/$/, "");
  return {
    async call<T>(site: string, method: string, path: string, input?: unknown): Promise<T> {
      const read = method === "GET" || method === "DELETE";
      let url = `${base}/api/sites/${site}${path}`;
      if (read && input && typeof input === "object") {
        const q = new URLSearchParams();
        for (const [k, v] of Object.entries(input as Record<string, unknown>))
          if (v !== undefined) q.set(k, String(v));
        if (q.size) url += `?${q}`;
      }
      const res = await fetchFn(url, {
        method,
        headers: {
          ...(read ? {} : { "content-type": "application/json" }),
          ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
        },
        ...(read ? {} : { body: JSON.stringify(input ?? {}) }),
        signal: AbortSignal.timeout(180_000),
      });
      const text = await res.text();
      const body = text ? (JSON.parse(text) as unknown) : null;
      if (!res.ok)
        throw new LadderCallError(
          `${site} ${method} ${path}: ${res.status} ${(body as { error?: string } | null)?.error ?? res.statusText}`,
          res.status,
        );
      return body as T;
    },
  };
}
