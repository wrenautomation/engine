/**
 * The client of autobrowse's fetch ladder, `web GET /fetch`. A caller asks it for a blocked
 * page; autobrowse climbs `impersonate`, `render` and `exit`. A block is data in the answer.
 * A failed call is the other result.
 */
/** The rungs a ladder climbs, lowest first. */
export const LADDER_TIERS = ["impersonate", "render", "exit"] as const;
export type LadderTier = (typeof LADDER_TIERS)[number];
export const isLadderTier = (tier: string | null | undefined): tier is LadderTier =>
  LADDER_TIERS.some((t) => t === tier);

/** Whoever answers `web GET /fetch`: autobrowse's site client, or a test double. */
export interface LadderClient {
  /** `account`: the credential the call runs as (`reddit@alt`); the worker's default when absent. */
  call<T>(
    site: string,
    method: string,
    path: string,
    input?: unknown,
    o?: { account?: string },
  ): Promise<T>;
}

/** One rung the ladder tried, and what it met there. */
export interface FetchStep {
  tier: string;
  status: number | null;
  block: string | null;
}

/** What `web GET /fetch` answers (`Fetched`): the fields this side reads. */
interface Fetched {
  finalUrl: string;
  status: number | null;
  html: string;
  /** The content-type the page answered with, when the worker says. */
  type?: string | null;
  /** The rung that answered: the last one tried. */
  tier: LadderTier;
  /** null: a usable page; else the signal the last rung still hit. */
  block: string | null;
  tries: FetchStep[];
}

/** `cap`: the day's `fetch` bucket is spent (429). `offline`: any other failed call. */
type LadderFailure = "cap" | "offline";

/** One `web GET /fetch`. A failed call is a result, never a throw. */
export async function fetchLadder(
  sites: LadderClient,
  url: string,
  from: LadderTier,
): Promise<{ fetched: Fetched } | { failed: LadderFailure }> {
  try {
    return { fetched: await sites.call<Fetched>("web", "GET", "/fetch", { url, from }) };
  } catch (err) {
    return { failed: (err as { status?: unknown }).status === 429 ? "cap" : "offline" };
  }
}
