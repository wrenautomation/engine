/**
 * Polite HTTP fetching, shared by every layer that touches the network: the
 * discovery ownership gate, the site crawler, bulk downloads. One class holds the
 * etiquette (declared User-Agent with contact info, per-host throttle, bounded
 * retries, never re-downloading what is on disk) so it cannot drift between callers.
 */
import { createWriteStream } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const DEFAULT_RETRIES = 3;
const BACKOFF_MS = 2000;

/**
 * A fetch that failed after retries. `status` is the last HTTP status when the
 * server answered (5xx after retries), null for transport failures: robots handling
 * needs the difference (a 503 robots.txt means disallow-all; a dead host means the
 * web's allow default).
 */
export class FetchError extends Error {
  override name = "FetchError";
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.status = status;
  }
}

/** The declared UA, or a loud failure: contact info is an explicit operator choice, never invented. */
export function userAgent(contact: string | null | undefined): string {
  if (!contact) {
    throw new FetchError(
      "outbound fetches need a contact (an email address or URL a remote operator could reach you at)",
    );
  }
  return `weaver/0.1 (${contact})`;
}

/** What one GET produced. `url` is the final URL after redirects. */
export interface FetchResponse {
  status: number;
  url: string;
  text: string;
  /** The `fetch_tier` the page was kept under, when it was not the caller's own plain fetch. */
  tier?: string;
}

/** The seam crawlers and gates depend on; tests substitute canned pages. */
export interface Fetcher {
  readonly userAgent: string;
  get(url: string): Promise<FetchResponse>;
}

export interface DownloadResult {
  path: string;
  /** false: already on disk, not re-fetched. */
  downloaded: boolean;
  size: number;
}

interface PoliteFetcherOptions {
  /** Seconds between requests to one host. */
  minInterval?: number;
  /** Extra uniform(lo, hi) seconds per request so crawls don't tick like a metronome. */
  jitter?: readonly [number, number] | null;
  timeout?: number;
  retries?: number;
  /** Test seams. */
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * fetch() wrapper enforcing UA + throttle + retry in one place. The throttle is per
 * host: a crawl across many small sites is not serialized globally.
 */
export class PoliteFetcher implements Fetcher {
  private readonly minIntervalMs: number;
  private readonly jitter: readonly [number, number] | null;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly lastRequest = new Map<string, number>();
  /** Requests to one host are serialized so concurrent callers still honor the interval. */
  private readonly hostQueues = new Map<string, Promise<void>>();

  constructor(
    readonly userAgent: string,
    opts: PoliteFetcherOptions = {},
  ) {
    this.minIntervalMs = (opts.minInterval ?? 1.0) * 1000;
    this.jitter = opts.jitter ?? null;
    this.timeoutMs = (opts.timeout ?? 30) * 1000;
    this.retries = Math.max(1, opts.retries ?? DEFAULT_RETRIES);
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.sleep = opts.sleep ?? defaultSleep;
    this.now = opts.now ?? (() => performance.now());
    this.random = opts.random ?? Math.random;
  }

  private async throttle(url: string): Promise<void> {
    let host = "";
    try {
      host = new URL(url).host;
    } catch {
      host = "";
    }
    const previous = this.hostQueues.get(host) ?? Promise.resolve();
    const turn = previous.then(async () => {
      let wait = this.minIntervalMs;
      if (this.jitter) {
        const [lo, hi] = this.jitter;
        wait += (lo + (hi - lo) * this.random()) * 1000;
      }
      const elapsed = this.now() - (this.lastRequest.get(host) ?? Number.NEGATIVE_INFINITY);
      if (elapsed < wait) await this.sleep(wait - elapsed);
      this.lastRequest.set(host, this.now());
    });
    this.hostQueues.set(
      host,
      turn.catch(() => {}),
    );
    await turn;
  }

  private request(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (!headers.has("user-agent")) headers.set("User-Agent", this.userAgent);
    return this.fetchImpl(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(this.timeoutMs),
      ...init,
      headers,
    });
  }

  /**
   * One throttled request as the raw `Response`, for a body the caller streams (a file it
   * filters as it lands) or a method other than GET. `init` wins: its signal replaces the
   * fetcher's timeout, its headers join the User-Agent. No retries: a half-read stream cannot be
   * asked again, so the caller decides what a bad status means.
   */
  async open(url: string, init: RequestInit = {}): Promise<Response> {
    await this.throttle(url);
    return this.request(url, init);
  }

  /**
   * GET with throttle and bounded retries. 4xx returns (the caller interprets: a
   * crawl 404 is data); transport errors and 5xx retry with backoff, then FetchError.
   */
  async get(url: string): Promise<FetchResponse> {
    let lastError = "";
    let lastStatus: number | null = null;
    for (let attempt = 0; attempt < this.retries; attempt++) {
      await this.throttle(url);
      try {
        const resp = await this.request(url);
        if (resp.status < 500) {
          return { status: resp.status, url: resp.url || url, text: await resp.text() };
        }
        lastError = `HTTP ${resp.status}`;
        lastStatus = resp.status;
        await resp.body?.cancel().catch(() => {});
      } catch (err) {
        lastError = describe(err);
        lastStatus = null;
      }
      if (attempt < this.retries - 1) await this.sleep(BACKOFF_MS * (attempt + 1));
    }
    throw new FetchError(
      `GET ${url} failed after ${this.retries} attempts: ${lastError}`,
      lastStatus,
    );
  }

  /**
   * Stream a (possibly large) file to `dest`; skip if already present. Writes to a
   * .part file and renames, so an interrupted download never masquerades as complete.
   */
  async download(url: string, dest: string): Promise<DownloadResult> {
    const existing = await stat(dest).catch(() => null);
    if (existing) return { path: dest, downloaded: false, size: existing.size };
    await mkdir(dirname(dest), { recursive: true });
    const tmp = `${dest}.part`;
    let lastError = "";
    for (let attempt = 0; attempt < this.retries; attempt++) {
      await this.throttle(url);
      try {
        const resp = await this.request(url);
        if (resp.status >= 400) {
          lastError = `HTTP ${resp.status}`;
          await resp.body?.cancel().catch(() => {});
          if (resp.status < 500) break; // 4xx will not improve on retry
          continue;
        }
        const body = resp.body ? Readable.fromWeb(resp.body as never) : Readable.from([]);
        await pipeline(body, createWriteStream(tmp));
        await rename(tmp, dest);
        const size = (await stat(dest)).size;
        return { path: dest, downloaded: true, size };
      } catch (err) {
        lastError = describe(err);
        if (attempt < this.retries - 1) await this.sleep(BACKOFF_MS * (attempt + 1));
      }
    }
    await unlink(tmp).catch(() => {});
    throw new FetchError(`download ${url} failed: ${lastError}`);
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const cause = err.cause instanceof Error ? `: ${err.cause.message}` : "";
    return `${err.name}: ${err.message}${cause}`;
  }
  return String(err);
}
