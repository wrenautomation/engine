/**
 * A failure worth another try: a 429, a 5xx, a dropped connection, a timeout. A source or a
 * model throws it; the runner tries the call again with a pause, writes every attempt's spend,
 * and when the tries run out lets it through: the step has no `done`, so a resume runs it again.
 * `retryAfter` is ISO time, from the server's `retry-after` when it sent one.
 */
export class Transient extends Error {
  readonly retryAfter: string | undefined;
  constructor(message: string, o: { retryAfter?: string | number | null } = {}) {
    super(message);
    this.name = "Transient";
    this.retryAfter = retryAfterIso(o.retryAfter);
  }
}

/** A `retry-after` value (seconds, an HTTP date or ISO time) as ISO time; undefined when unreadable. */
export function retryAfterIso(
  value: string | number | null | undefined,
  now: () => Date = () => new Date(),
): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const seconds = typeof value === "number" ? value : Number(value);
  if (Number.isFinite(seconds)) return new Date(now().getTime() + seconds * 1000).toISOString();
  const t = Date.parse(String(value));
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

/** A status worth another try: 429 and every 5xx. */
export const transientStatus = (status: number): boolean => status === 429 || status >= 500;

/** The error for a response that is not ok: Transient on 429 or 5xx, a plain Error otherwise. */
export function httpError(what: string, res: Response, detail?: string): Error {
  const message = `${what}: HTTP ${res.status}${detail ? ` ${detail}` : ""}`;
  return transientStatus(res.status)
    ? new Transient(message, { retryAfter: res.headers.get("retry-after") })
    : new Error(message);
}

/** A fetch that threw (the network, a timeout): always transient. */
export const transport = (what: string, err: unknown): Transient =>
  new Transient(`${what}: ${err instanceof Error ? err.message : String(err)}`);
