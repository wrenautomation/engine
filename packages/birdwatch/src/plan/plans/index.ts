/**
 * The default plan file per ask kind. A copy of one, tuned and stored beside a ledger, is how
 * a run learns: the recipe changes, the planner does not. `birdwatch plans <kind>` prints one to start from.
 */
import {
  type AskKind,
  type PlanFile,
  PlanFile as PlanFileShape,
  type TreeGuide,
} from "../types.js";

const SHAPE_QUERIES = `Return ONLY a JSON object, no prose, exactly this shape:
{"queries": [{"terms": "...", "why": "..."}]}`;
const SHAPE_HITS = `Return ONLY a JSON object, no prose, exactly this shape:
{"hits": [{"url": "...", "read": true, "why": "..."}, {"url": "...", "read": false}]}`;
const SHAPE_EDGE = `Return ONLY a JSON object, no prose, exactly this shape:
{"next": "stop", "why": "..."}
where "next" is "stop", "again" (a new round from plan) or "back" (rerun one step of this round, named in "to": "plan", "fetch", "triage", "read" or "extract").`;

const CONTEXT = `Ask: {ask}
{steer}{open}Known already (look past these):
{known}
What yielded before (hits, reads, proposed, kept):
{yield}`;

const TRIAGE_RULES = `- One entry per hit, with its url as given. Mark "read": true for at most {n}.
- Read a hit when what it shows for free (title, snippet, channel, length, date) says it holds what the ask needs and is not known already.
- A hit returned by more than one source is a good sign, not a duplicate.
- "why" on a read only: one short line a person reads to agree or not. A skip has no "why".{age}`;

const REVIEW = `You decide what happens after one round of research.

${SHAPE_EDGE}

Rules:
- "stop" when the found lines answer the ask, or when another round would likely add nothing. New hits and kept findings that fall round by round point that way.
- "again" when the ask is still open and new queries could find more. The gaps say what is missing; say what to look for next in "why".
- "again" too when the reads were mostly "thin" or "off": the queries found the wrong pages, so plan different ones.
- "back" when one step of this round failed for a reason a rerun fixes (a source was down, reads timed out). Name the step in "to".
- The gaps are what a step or the person said this round lacks: a query with no new hits, a page no source could open. Weigh them like the verdicts.
- A check that failed means a finding's quote does not back it, and the finding was dropped. Many failed checks mean the reads were poor: say so in "why".{age}
- "why" is one short line a person reads to agree or not. On "again" it is what the next plan reads first.

Ask: {ask}
{steer}Round {round}; the budget is {rounds} rounds, a guard rail (past it the runner parks and a person decides), not a stop rule. Hits {hits}, reads {reads}, findings proposed {proposed}, kept {kept}.
Found (the source's date in brackets when it gives one):
{found}
Read (quality: rich, thin, off or empty; then the gap, what the ask still lacks):
{verdicts}
Gaps (the step or the person, then what is missing):
{gaps}
Checked (a sample of the kept findings, each against its document):
{checks}
Notes:
{notes}`;

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
  propose: `You plan web searches for one research ask.

${SHAPE_QUERIES}

Rules:
- At most {n} queries, each 3 to 10 words, as a person types into a search engine.
- Each query finds a different kind of source: a survey or benchmark with numbers, a trade publication or industry association, people in the field talking (forums, Reddit, reviews), a government statistic.
- "why" says in one short line what the query would add that is not known yet.
- Put a year in a query only when fresh numbers matter. This year is {year}.
- No site: operators. Quotes only around a phrase that must match exactly.

${CONTEXT}`,
  triage: `You decide which search hits to read for one research ask. A read costs time; a skip costs nothing.

${SHAPE_HITS}

Rules:
${TRIAGE_RULES}
- Prefer primary sources and people in the field over listicles and aggregators.

${CONTEXT}
Hits:
{hits}`,
  review: REVIEW,
  sources: ["searxng", "exa", "google"],
  budget: { queries: 3, reads: 6, rounds: 3, checks: 3 },
  tree: TREE,
  age: "Prices, tools and numbers that move: prefer the last two years. A principle or a method can be old.",
};

const video: PlanFile = {
  id: "birdwatch/video",
  kind: "video",
  version: 6,
  propose: `You plan video searches for one research ask: talks, walkthroughs, interviews and reviews on YouTube and podcast feeds.

${SHAPE_QUERIES}

Rules:
- At most {n} queries, each 2 to 8 words, as a person types into a video search box.
- Each query reaches a different kind of speaker: a practitioner showing their work, a conference talk, an interview or podcast, a critic or reviewer.
- "why" says in one short line what the query would add that is not known yet.
- This year is {year}; add it only when the topic moves fast.

${CONTEXT}`,
  triage: `You decide which videos to read (transcript and screen) for one research ask. A read costs minutes per video; a skip costs nothing.

${SHAPE_HITS}

Rules:
${TRIAGE_RULES}
- Length is in seconds. Skip a clip under 60 seconds unless the ask is about short-form video. Prefer 5 to 60 minutes.
- A channel that yielded nothing before is a reason to skip.

${CONTEXT}
Hits:
{hits}`,
  review: REVIEW,
  sources: ["youtube", "podcasts"],
  budget: { queries: 3, reads: 4, rounds: 2, checks: 3 },
  tree: TREE,
  age: "Tools and platforms: prefer the last two years. A talk on a principle can be old.",
};

const channel: PlanFile = {
  id: "birdwatch/channel",
  kind: "channel",
  version: 6,
  propose: `You plan searches that find the people and channels worth following for one research ask: creators, newsletters, podcasts, forums.

${SHAPE_QUERIES}

Rules:
- At most {n} queries, each 3 to 10 words.
- Each query finds a different kind of channel: a creator on video, a writer or newsletter, a podcast, a community.
- "why" says in one short line what the query would add that is not known yet.

${CONTEXT}`,
  triage: `You decide which channel pages to read for one research ask: a profile, an about page, a feed. A read costs time; a skip costs nothing.

${SHAPE_HITS}

Rules:
${TRIAGE_RULES}
- Prefer the channel's own page over a page about it.

${CONTEXT}
Hits:
{hits}`,
  review: REVIEW,
  sources: ["searxng", "youtube", "exa"],
  budget: { queries: 3, reads: 6, rounds: 2, checks: 3 },
  tree: TREE,
  age: "A channel that has not posted in the last year counts for little.",
};

const person: PlanFile = {
  id: "birdwatch/person",
  kind: "person",
  version: 6,
  propose: `You plan searches about one person or company for one research ask: what they do, what they said, what others say about them.

${SHAPE_QUERIES}

Rules:
- At most {n} queries, each 3 to 10 words. Name the person or company in each, as written in the ask.
- Each query finds a different kind of page: their own site or profile, an interview or talk, press or reviews, a filing or directory.
- "why" says in one short line what the query would add that is not known yet.
- No site: operators.

${CONTEXT}`,
  triage: `You decide which pages about one person or company to read for one research ask. A read costs time; a skip costs nothing.

${SHAPE_HITS}

Rules:
${TRIAGE_RULES}
- Skip a page about a different person or company with the same name.
- Prefer what they wrote or said over what a directory copied.

${CONTEXT}
Hits:
{hits}`,
  review: REVIEW,
  sources: ["searxng", "exa", "linkedin", "google"],
  budget: { queries: 4, reads: 6, rounds: 2, checks: 3 },
  tree: TREE,
  age: "What they do now: prefer the latest pages. Their history can be old.",
};

const site: PlanFile = {
  id: "birdwatch/site",
  kind: "site",
  version: 6,
  propose: `You plan searches inside one website for one research ask. Every query runs on {site} only.

${SHAPE_QUERIES}

Rules:
- At most {n} queries, each 2 to 8 words, as a person types into the site's own search box.
- Each query reaches a different part of the site: its product or service pages, its pricing, its blog or help, its people.
- "why" says in one short line what the query would add that is not known yet.
- No site: operators: the site is set for you.

${CONTEXT}`,
  triage: `You decide which pages of {site} to read for one research ask. A read costs time; a skip costs nothing.

${SHAPE_HITS}

Rules:
${TRIAGE_RULES}
- Skip a url off {site}.

${CONTEXT}
Hits:
{hits}`,
  review: REVIEW,
  sources: ["sitemap", "searxng", "fetch"],
  budget: { queries: 4, reads: 8, rounds: 2, checks: 3 },
  tree: TREE,
  age: "When two pages of the site disagree, the later one counts.",
};

const DEFAULTS: Record<AskKind, PlanFile> = { web, video, channel, person, site };

/** The default plan file for a kind, validated, as a fresh copy. */
export function defaultPlanFile(kind: AskKind): PlanFile {
  return PlanFileShape.parse(structuredClone(DEFAULTS[kind]));
}

/** The plan file's word on age; a stored file from before version 4 takes its kind's default. Version 5: the review no longer says "at most". Version 6: `tree`, the query tree's guide. */
export const ageOf = (planFile: PlanFile): string | undefined =>
  planFile.age ?? DEFAULTS[planFile.kind].age;

/** The plan file's guide for a query tree; a stored file from before version 6 takes its kind's default. */
export const treeOf = (planFile: PlanFile): TreeGuide =>
  planFile.tree ?? (DEFAULTS[planFile.kind].tree as TreeGuide);

export const PLAN_KINDS = Object.keys(DEFAULTS) as AskKind[];
