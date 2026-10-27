/**
 * The default plan file per ask kind. A copy of one, tuned and stored beside a ledger, is how
 * a run learns: the recipe changes, raven does not. `raven plans <kind>` prints one to start from.
 */
import { type AskKind, type PlanFile, PlanFile as PlanFileShape } from "../types.js";

const SHAPE_QUERIES = `Return ONLY a JSON object, no prose, exactly this shape:
{"queries": [{"terms": "...", "why": "..."}]}`;
const SHAPE_HITS = `Return ONLY a JSON object, no prose, exactly this shape:
{"hits": [{"url": "...", "read": true, "why": "..."}]}`;
const SHAPE_EDGE = `Return ONLY a JSON object, no prose, exactly this shape:
{"next": "stop", "why": "..."}
where "next" is "stop", "again" (a new round from plan) or "back" (rerun one step of this round, named in "to": "plan", "fetch", "triage", "read" or "extract").`;

const CONTEXT = `Ask: {ask}
Known already (look past these):
{known}
What yielded before (hits, reads, proposed, kept):
{yield}`;

const TRIAGE_RULES = `- One entry per hit, with its url as given. Mark "read": true for at most {n}.
- Read a hit when what it shows for free (title, snippet, channel, length, date) says it holds what the ask needs and is not known already.
- A hit returned by more than one source is a good sign, not a duplicate.
- "why" is one short line a person reads to agree or not.`;

const REVIEW = `You decide what happens after one round of research.

${SHAPE_EDGE}

Rules:
- "stop" when the found lines answer the ask, or when another round would likely add nothing.
- "again" when the ask is still open and new queries could find more. Say what to look for next in "why".
- "back" when one step of this round failed for a reason a rerun fixes (a source was down, reads timed out). Name the step in "to".
- "why" is one short line a person reads to agree or not.

Ask: {ask}
Round {round} of at most {rounds}. Hits {hits}, reads {reads}, findings proposed {proposed}, kept {kept}.
Found:
{found}
Notes:
{notes}`;

const web: PlanFile = {
  id: "raven/web",
  kind: "web",
  version: 1,
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
  budget: { queries: 3, reads: 6, rounds: 3 },
};

const video: PlanFile = {
  id: "raven/video",
  kind: "video",
  version: 1,
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
  budget: { queries: 3, reads: 4, rounds: 2 },
};

const channel: PlanFile = {
  id: "raven/channel",
  kind: "channel",
  version: 1,
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
  budget: { queries: 3, reads: 6, rounds: 2 },
};

const person: PlanFile = {
  id: "raven/person",
  kind: "person",
  version: 1,
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
  budget: { queries: 4, reads: 6, rounds: 2 },
};

const site: PlanFile = {
  id: "raven/site",
  kind: "site",
  version: 1,
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
  budget: { queries: 4, reads: 8, rounds: 2 },
};

const DEFAULTS: Record<AskKind, PlanFile> = { web, video, channel, person, site };

/** The default plan file for a kind, validated, as a fresh copy. */
export function defaultPlanFile(kind: AskKind): PlanFile {
  return PlanFileShape.parse(structuredClone(DEFAULTS[kind]));
}

export const PLAN_KINDS = Object.keys(DEFAULTS) as AskKind[];
