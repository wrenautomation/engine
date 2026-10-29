/**
 * robots.txt reading, shared by every page-fetching consumer.
 *
 * The policy that binds a fetch is the one on the HOST actually being fetched, over
 * the SCHEME actually in use: apex and www can serve different files, so policies
 * are cached per scheme+host and fetched over the URL's own scheme.
 *
 * Absence semantics follow RFC 9309: a missing robots.txt (404, or a dead host)
 * means everything is allowed, but a server that ANSWERED 5xx is saying
 * "unavailable", which means full disallow.
 *
 * Matching is robots-parser's RFC 9309 reading: the group for our product token
 * (groups naming it merged), else `*`; the longest matching rule wins, Allow on a
 * tie; `*` and `$` in paths.
 */
import parseRobots from "robots-parser";
import { FetchError, type Fetcher } from "./fetcher.js";

/** robots-parser checks a URL's origin against the file's; ours are read per origin, so one stand-in. */
const ORIGIN = "https://robots.invalid";

interface Robot {
  isAllowed(url: string, ua?: string): boolean | undefined;
}
// A CommonJS module: at runtime the default import is the function its typings
// declare, which NodeNext resolution types as a namespace instead.
const robotsParser = parseRobots as unknown as (url: string, text: string) => Robot;

export class RobotsPolicy {
  private constructor(
    private readonly robot: Robot | null,
    private readonly disallowAll: boolean,
  ) {}

  static allowAll(): RobotsPolicy {
    return new RobotsPolicy(null, false);
  }
  static disallowAll(): RobotsPolicy {
    return new RobotsPolicy(null, true);
  }

  static parse(text: string): RobotsPolicy {
    return new RobotsPolicy(robotsParser(`${ORIGIN}/robots.txt`, text), false);
  }

  canFetch(userAgent: string, url: string): boolean {
    if (this.disallowAll) return false;
    if (!this.robot) return true;
    return this.robot.isAllowed(onOrigin(url), userAgent) ?? true;
  }
}

/** The url's path and query on the stand-in origin; an unparseable url reads as `/`. */
function onOrigin(url: string): string {
  try {
    const u = new URL(url);
    return `${ORIGIN}${u.pathname}${u.search}`;
  } catch {
    return `${ORIGIN}/`;
  }
}

export type RobotsCache = Map<string, RobotsPolicy>;

/** The robots policy for this url's scheme+host, fetched once each. */
export async function robotsFor(
  fetcher: Fetcher,
  url: string,
  cache: RobotsCache,
): Promise<RobotsPolicy> {
  let key: string;
  try {
    const u = new URL(url);
    key = `${u.protocol}//${u.host}`;
  } catch {
    key = `https://${url}`;
  }
  const hit = cache.get(key);
  if (hit) return hit;
  let policy: RobotsPolicy;
  try {
    const resp = await fetcher.get(`${key}/robots.txt`);
    policy = resp.status === 200 ? RobotsPolicy.parse(resp.text) : RobotsPolicy.allowAll();
  } catch (err) {
    if (err instanceof FetchError && err.status !== null && err.status >= 500) {
      policy = RobotsPolicy.disallowAll(); // "unavailable" is not "absent"
    } else if (err instanceof FetchError) {
      policy = RobotsPolicy.allowAll(); // unreachable host: the web's allow default
    } else {
      throw err;
    }
  }
  cache.set(key, policy);
  return policy;
}

export async function canFetch(
  fetcher: Fetcher,
  url: string,
  cache: RobotsCache,
): Promise<boolean> {
  return (await robotsFor(fetcher, url, cache)).canFetch(fetcher.userAgent, url);
}
