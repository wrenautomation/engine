/**
 * The fetch ladder as an open source: `web GET /fetch` on a site client, up to a browser. Only
 * worth a call after the plain fetcher came back empty or blocked, so it sits after `fetcher` in
 * a plan file's sources. Browser cost, and one of the worker's daily `fetch` bucket per call. A
 * block the last rung still hit, a spent bucket or a page that is not HTML is a miss (a throw
 * with the reason); a worker that did not answer is a Transient.
 *
 * Two wires to an autobrowse worker for a terminal run: `httpLadderClient` for its HTTP face
 * (`GET $url/api/sites/web/fetch?url=&from=`, a bearer token); `ingressLadderClient` for the
 * Restate ingress the desk worker sits behind (`POST $url/desk/call`, the same bearer).
 */

import { Transient } from "@wrenautomation/models";
import { fetchLadder, type LadderClient, type LadderTier } from "@wrenautomation/read/fetch";
import { defaultReaders, type Media, type Reader } from "../document/index.js";
import type { Source } from "../engine/ports.js";
import { isPage } from "./fetcher.js";
import { junkReason } from "./junk.js";

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
    opens: isPage,
    async open(h) {
      if (!isPage(h.url)) throw new Error(`ladder: not a page: ${h.url}`);
      const r = await fetchLadder(o.sites, h.url, o.from ?? "impersonate");
      // offline: the worker did not answer, worth another try. The rest is a miss, like the
      // fetcher's 403: the read step writes a gap and goes on to the next hit.
      if ("failed" in r) {
        if (r.failed === "offline") throw new Transient("ladder: offline");
        throw new Error("ladder: the worker's fetch bucket is spent for today");
      }
      if (r.fetched.block) throw new Error(`ladder: ${r.fetched.block} at ${r.fetched.tier}`);
      // The ladder answers the body as text: only HTML reads right that way.
      const type = r.fetched.type?.split(";")[0]?.trim().toLowerCase();
      if (type && type !== "text/html" && type !== "application/xhtml+xml")
        throw new Error(`ladder: ${type} is not html`);
      const html = readers.get("html");
      if (!html) throw new Error("ladder: no html reader");
      const doc = await html.read({
        url: r.fetched.finalUrl || h.url,
        text: r.fetched.html,
        ...(h.title ? { title: h.title } : {}),
      });
      if (!doc) throw new Error("ladder: nothing to read in the page");
      const junk = junkReason(doc, r.fetched.status);
      if (junk) throw new Error(`ladder: ${junk} at ${r.fetched.tier}`);
      return doc;
    },
  };
}

export class LadderCallError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The worker's access code (`need_login`, `platform_blocked`, `rate_limited`, `upstream_broken`), when it sent one. */
    readonly code: string | null = null,
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
    async call<T>(
      site: string,
      method: string,
      path: string,
      input?: unknown,
      as?: { account?: string },
    ): Promise<T> {
      const read = method === "GET" || method === "DELETE";
      let url = `${base}/api/sites/${site}${path}`;
      const q = new URLSearchParams();
      if (read && input && typeof input === "object")
        for (const [k, v] of Object.entries(input as Record<string, unknown>))
          if (v !== undefined) q.set(k, String(v));
      // autobrowse takes `account` beside the query, for writes too.
      if (as?.account) q.set("account", as.account);
      if (q.size) url += `?${q}`;
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
      if (!res.ok) {
        const b = body as { error?: string; code?: string } | null;
        throw new LadderCallError(
          `${site} ${method} ${path}: ${res.status} ${b?.error ?? res.statusText}`,
          res.status,
          b?.code ?? null,
        );
      }
      return body as T;
    },
  };
}

/**
 * The Restate ingress wire to an autobrowse worker: `POST $url/$service/call` with the site
 * call as its body, the way wren's CLI reaches the desk. `service` is `desk` (the Mac) or
 * `sites` (a box); `caller` names who asks, for the worker's per-caller usage. Restate answers a
 * refused call as `{"code":429,"message":"…"}` under that status: a 429 is the ladder's "cap".
 * A coded refusal adds `"metadata":{"code":"need_login"}`.
 */
export function ingressLadderClient(o: {
  url: string;
  token?: string | null;
  service?: string;
  caller?: string;
  fetchFn?: typeof fetch;
}): LadderClient {
  const fetchFn = o.fetchFn ?? fetch;
  const base = o.url.replace(/\/$/, "");
  const service = o.service ?? "desk";
  const caller = o.caller ?? "birdwatch";
  return {
    async call<T>(
      site: string,
      method: string,
      path: string,
      input?: unknown,
      as?: { account?: string },
    ): Promise<T> {
      const res = await fetchFn(`${base}/${service}/call`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
          ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
        },
        body: JSON.stringify({
          site,
          method,
          path,
          input: input ?? {},
          caller,
          ...(as?.account ? { account: as.account } : {}),
        }),
        signal: AbortSignal.timeout(180_000),
      });
      const text = await res.text();
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      if (!res.ok) {
        const said =
          body && typeof body === "object" && "message" in body
            ? String((body as { message: unknown }).message)
            : text || res.statusText;
        // A coded refusal: autobrowse puts the access code in the terminal error's metadata.
        const code = (body as { metadata?: { code?: unknown } } | null)?.metadata?.code;
        throw new LadderCallError(
          `${site} ${method} ${path}: ${res.status} ${said}`,
          res.status,
          typeof code === "string" ? code : null,
        );
      }
      return body as T;
    },
  };
}
