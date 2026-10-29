/**
 * The default plan file per ask kind. A copy of one, tuned and stored beside a ledger, is how
 * a run learns: the recipe changes, the agent reads it. `birdwatch plans <kind>` prints one to start from.
 */
import {
  type AskKind,
  type PlanFile,
  PlanFile as PlanFileShape,
  type TreeGuide,
} from "../types.js";

/**
 * The five sides a researcher covers before the reads start. One tree per round; the agent
 * fills each facet with tries, in order of what it expects to work.
 */
export const TREE: TreeGuide = {
  facets: [
    { name: "number", why: "a figure: a rate, a price, a count, a date" },
    { name: "how", why: "how it is done: a method, a step list, a tool" },
    { name: "who", why: "who does it or buys it, in their own words" },
    { name: "counter", why: "the case against: what fails, who says no" },
    {
      name: "primary",
      why: "the source itself: a study, a filing, a transcript, the maker's own page",
    },
  ],
  thin: 3,
};

const web: PlanFile = {
  id: "birdwatch/web",
  kind: "web",
  version: 6,
  sources: ["searxng", "exa", "google"],
  budget: { queries: 3, reads: 6, rounds: 3, checks: 3 },
  tree: TREE,
  age: "Prices, tools and numbers that move: prefer the last two years. A principle or a method can be old.",
  rules: [
    "Each facet's tries reach different kinds of source: a survey or benchmark with numbers, a trade publication or association, people in the field (forums, Reddit, reviews), a government statistic.",
    "Put a year in a query only when fresh numbers matter.",
    "Keep primary sources and people in the field over listicles and aggregators.",
  ],
};

const video: PlanFile = {
  id: "birdwatch/video",
  kind: "video",
  version: 6,
  sources: ["youtube", "podcasts"],
  budget: { queries: 3, reads: 4, rounds: 2, checks: 3 },
  tree: TREE,
  age: "Tools and platforms: prefer the last two years. A talk on a principle can be old.",
  rules: [
    "Each facet's tries reach different kinds of speaker: a practitioner who shows the work, a conference talk, an interview or podcast, a critic or reviewer.",
    "Drop a clip under 60 seconds unless the ask is about short-form video. Videos of 5 to 60 minutes hold the most.",
    "A channel that yielded nothing before is a reason to drop.",
  ],
};

const channel: PlanFile = {
  id: "birdwatch/channel",
  kind: "channel",
  version: 6,
  sources: ["searxng", "youtube", "exa"],
  budget: { queries: 3, reads: 6, rounds: 2, checks: 3 },
  tree: TREE,
  age: "A channel that has not posted in the last year counts for little.",
  rules: [
    "Each facet's tries reach different kinds of channel: a creator on video, a writer or newsletter, a podcast, a community.",
    "Keep the channel's own page over a page about it.",
  ],
};

const person: PlanFile = {
  id: "birdwatch/person",
  kind: "person",
  version: 6,
  sources: ["searxng", "exa", "linkedin", "google"],
  budget: { queries: 4, reads: 6, rounds: 2, checks: 3 },
  tree: TREE,
  age: "What they do now: prefer the latest pages. Their history can be old.",
  rules: [
    "Name the person or company in each query, as the ask writes it.",
    "Each facet's tries reach different kinds of page: their own site or profile, an interview or talk, press or reviews, a filing or directory.",
    "Drop a page about a different person or company with the same name.",
    "Keep what they wrote or said over what a directory copied.",
  ],
};

const site: PlanFile = {
  id: "birdwatch/site",
  kind: "site",
  version: 6,
  sources: ["sitemap", "searxng", "fetch"],
  budget: { queries: 4, reads: 8, rounds: 2, checks: 3 },
  tree: TREE,
  age: "When two pages of the site disagree, the later one counts.",
  rules: [
    "Each facet's tries reach different parts of the site: its product or service pages, its pricing, its blog or help, its people.",
    "Drop a URL off the site.",
  ],
};

const DEFAULTS: Record<AskKind, PlanFile> = { web, video, channel, person, site };

/** The default plan file for a kind, validated, as a fresh copy. */
export function defaultPlanFile(kind: AskKind): PlanFile {
  return PlanFileShape.parse(structuredClone(DEFAULTS[kind]));
}

/** The plan file's word on age; a stored file from before version 4 takes its kind's default. Version 5: the review no longer says "at most". Version 6: `tree`, the query tree's guide. 0.30.0 dropped the prompts with no bump: the agent never read them. */
export const ageOf = (planFile: PlanFile): string | undefined =>
  planFile.age ?? DEFAULTS[planFile.kind].age;

/** The plan file's rules for the agent; a stored file from before 0.30.0 takes its kind's default. */
export const rulesOf = (planFile: PlanFile): string[] =>
  planFile.rules ?? DEFAULTS[planFile.kind].rules ?? [];

/** The plan file's guide for a query tree; a stored file from before version 6 takes its kind's default. */
export const treeOf = (planFile: PlanFile): TreeGuide =>
  planFile.tree ?? (DEFAULTS[planFile.kind].tree as TreeGuide);

export const PLAN_KINDS = Object.keys(DEFAULTS) as AskKind[];
