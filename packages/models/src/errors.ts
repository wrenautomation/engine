/**
 * What a model call throws, by what the caller does next. `Transient`: try again later (429, 5xx,
 * a dropped connection). `Refused`: this key is bad (401, 402, 403); the key ring moves on.
 * `InputRejected`: the vendor refused this input (400, 413, 422); record it and go on.
 * `Unsupported`: the model cannot take a part it was given. `Cut`: the output cap stopped the
 * answer; the text so far and its tokens come with it. `Filtered`: the vendor stopped the answer
 * itself (a safety or recitation filter, a failed run); `stop` says which, and asking in other
 * words may pass. Each is checked by shape too (`isCut`):
 * a host may hold two copies of this package while its pins catch up.
 */
import type { PartKind, Usage } from "./types.js";

export class Transient extends Error {
  /** ISO time, from the server's `retry-after` when it sent one. */
  readonly retryAfter: string | undefined;
  readonly status: number | undefined;
  constructor(
    message: string,
    o: { retryAfter?: string | number | null | undefined; status?: number; cause?: unknown } = {},
  ) {
    super(message, o.cause === undefined ? undefined : { cause: o.cause });
    this.name = "Transient";
    this.retryAfter = retryAfterIso(o.retryAfter);
    this.status = o.status;
  }
}

export class Refused extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "Refused";
    this.status = status;
  }
}

export class InputRejected extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "InputRejected";
    this.status = status;
  }
}

export class Unsupported extends Error {
  readonly kind: PartKind;
  constructor(model: string, kind: PartKind) {
    super(`${model} takes no ${kind} part`);
    this.name = "Unsupported";
    this.kind = kind;
  }
}

export class Cut extends Error {
  readonly partial: string;
  readonly usage: Usage | undefined;
  constructor(message: string, partial: string, usage?: Usage) {
    super(message);
    this.name = "Cut";
    this.partial = partial;
    this.usage = usage;
  }
}

export class Filtered extends Error {
  /** The vendor's stop reason (`RECITATION`, `SAFETY`, `refusal`). */
  readonly stop: string;
  readonly partial: string;
  readonly usage: Usage | undefined;
  constructor(message: string, stop: string, partial: string, usage?: Usage) {
    super(message);
    this.name = "Filtered";
    this.stop = stop;
    this.partial = partial;
    this.usage = usage;
  }
}

const named = (err: unknown, name: string): err is Error =>
  err instanceof Error && err.name === name;

export const isCut = (err: unknown): err is Cut =>
  named(err, "Cut") && typeof (err as Cut).partial === "string";
export const isFiltered = (err: unknown): err is Filtered =>
  named(err, "Filtered") && typeof (err as Filtered).stop === "string";
export const isTransient = (err: unknown): err is Transient => named(err, "Transient");
export const isRefused = (err: unknown): err is Refused => named(err, "Refused");
export const isInputRejected = (err: unknown): err is InputRejected => named(err, "InputRejected");

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

/** A status worth another try: 408, 429 and every 5xx. */
export const transientStatus = (status: number): boolean =>
  status === 408 || status === 429 || status >= 500;

const REFUSED: ReadonlySet<number> = new Set([401, 402, 403]);
const REJECTED: ReadonlySet<number> = new Set([400, 413, 422]);

/** The error for an HTTP status, by what the caller does next. */
export function statusError(
  message: string,
  status: number,
  retryAfter?: string | number | null,
): Error {
  if (transientStatus(status)) return new Transient(message, { retryAfter, status });
  if (REFUSED.has(status)) return new Refused(message, status);
  if (REJECTED.has(status)) return new InputRejected(message, status);
  return new Error(message);
}

/** The error for a response that is not ok. */
export const httpError = (what: string, res: Response, detail?: string): Error =>
  statusError(
    `${what}: HTTP ${res.status}${detail ? ` ${detail}` : ""}`,
    res.status,
    res.headers.get("retry-after"),
  );

/** `text` with each secret (an API key) put out: a vendor may echo the key in its message. */
export const redact = (text: string, secrets: readonly string[] = []): string =>
  secrets.reduce((t, s) => (s.length >= 8 ? t.split(s).join("[key]") : t), text);

/** A fetch that threw (the network, a timeout): always transient. */
export const transport = (what: string, err: unknown): Transient =>
  new Transient(`${what}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
