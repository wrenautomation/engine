import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FetchError, PoliteFetcher, userAgent } from "./fetcher.js";

type Script = Array<{ status: number; body?: string; throw?: Error }>;

function scripted(script: Script) {
  const calls: Array<{ url: string; ua: string | undefined }> = [];
  const sleeps: number[] = [];
  let clock = 0;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ua: new Headers(init?.headers).get("user-agent") ?? undefined });
    const step = script.shift();
    if (!step) throw new Error("script exhausted");
    if (step.throw) throw step.throw;
    return new Response(step.body ?? "", { status: step.status });
  }) as typeof globalThis.fetch;
  const fetcher = new PoliteFetcher("weaver/0.1 (t@example.com)", {
    fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    retries: 3,
  });
  return { fetcher, calls, sleeps };
}

describe("userAgent", () => {
  it("needs a contact", () => {
    expect(userAgent("me@example.com")).toBe("weaver/0.1 (me@example.com)");
    expect(() => userAgent(null)).toThrow(/need a contact/);
  });
});

describe("PoliteFetcher.get", () => {
  it("sends the UA, returns 4xx as data", async () => {
    const { fetcher, calls } = scripted([{ status: 404, body: "gone" }]);
    const resp = await fetcher.get("https://a.example/x");
    expect(resp.status).toBe(404);
    expect(resp.text).toBe("gone");
    expect(calls[0]?.ua).toBe("weaver/0.1 (t@example.com)");
  });

  it("retries transport errors and 5xx with backoff, then raises with the last status", async () => {
    const { fetcher, sleeps } = scripted([
      { status: 0, throw: new TypeError("fetch failed") },
      { status: 503 },
      { status: 502 },
    ]);
    const err = await fetcher.get("https://a.example/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FetchError);
    expect((err as FetchError).status).toBe(502);
    expect((err as FetchError).message).toMatch(/3 attempts: HTTP 502/);
    expect(sleeps.filter((ms) => ms >= 2000)).toEqual([2000, 4000]);
  });

  it("recovers on a later attempt", async () => {
    const { fetcher } = scripted([{ status: 500 }, { status: 200, body: "ok" }]);
    expect((await fetcher.get("https://a.example/x")).text).toBe("ok");
  });

  it("throttles per host", async () => {
    const { fetcher, sleeps } = scripted([{ status: 200 }, { status: 200 }, { status: 200 }]);
    await fetcher.get("https://a.example/1");
    await fetcher.get("https://a.example/2");
    await fetcher.get("https://b.example/1");
    // second request to a.example waited the full interval; b.example did not wait at all
    expect(sleeps).toEqual([1000]);
  });
});

describe("PoliteFetcher.download", () => {
  it("streams to a .part file, then renames; skips existing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dl-"));
    const dest = join(dir, "sub", "file.txt");
    const { fetcher } = scripted([{ status: 200, body: "payload" }]);
    const first = await fetcher.download("https://a.example/f", dest);
    expect(first).toEqual({ path: dest, downloaded: true, size: 7 });
    expect(readFileSync(dest, "utf8")).toBe("payload");
    const again = await fetcher.download("https://a.example/f", dest);
    expect(again.downloaded).toBe(false);
  });

  it("4xx does not retry; failure leaves no .part", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dl-"));
    const dest = join(dir, "file.txt");
    const { fetcher, calls } = scripted([{ status: 404 }]);
    await expect(fetcher.download("https://a.example/f", dest)).rejects.toThrow(/HTTP 404/);
    expect(calls).toHaveLength(1);
    writeFileSync(join(dir, "marker"), "");
    expect(() => readFileSync(`${dest}.part`)).toThrow();
  });
});

describe("PoliteFetcher.open", () => {
  it("throttles, sends the UA beside the caller's headers and method, and returns the raw response", async () => {
    const seen: RequestInit[] = [];
    const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      seen.push(init ?? {});
      return new Response("ok", { status: 503 });
    }) as typeof globalThis.fetch;
    const sleeps: number[] = [];
    let clock = 0;
    const fetcher = new PoliteFetcher("weaver/0.1 (t@example.com)", {
      fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      now: () => clock,
    });
    const signal = AbortSignal.timeout(60_000);
    const first = await fetcher.open("https://a.example/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal,
    });
    // A bad status comes back as is: no retry, the caller reads it.
    expect(first.status).toBe(503);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.signal).toBe(signal);
    const h = new Headers(seen[0]?.headers);
    expect(h.get("user-agent")).toBe("weaver/0.1 (t@example.com)");
    expect(h.get("content-type")).toBe("application/json");
    await fetcher.open("https://a.example/next");
    expect(sleeps).toEqual([1000]);
  });
});
