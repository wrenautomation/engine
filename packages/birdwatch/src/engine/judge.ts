/**
 * The judge's passes: cheap labels on every hit, document and finding, written as `judge`
 * records. Labels and routing only, no quality call (William, 11-03): it says what a page is
 * (class, format, side, the ask's criteria), never whether it is good. The agent reads and
 * calls every hit. The check sends each finding the judge doubts to the model: more checks,
 * never fewer. A failed judge call writes its spend
 * and the step goes on; a refused key ends the pass.
 */

import {
  choice,
  type EntryType,
  type Judged,
  noul,
  type Probs,
  type Questions,
  top,
} from "@wrenautomation/models/judge";
import { bodyOf, contextOf } from "../document/index.js";
import {
  type DocumentRecord,
  type FindingRecord,
  type HitRecord,
  SOURCE_CLASSES,
  type SourceClass,
} from "../ledger/records.js";
import type { Criterion } from "./plan.js";
import { kept, type RunState } from "./state.js";
import type { StepContext } from "./steps.js";

/** Judge calls in flight at once. */
export const JUDGE_PARALLEL = 8;
/** A finding the judge backs under this goes to the model's check. */
export const DOUBT = 0.8;
/**
 * Characters per judge call on a page read whole. Jev takes about 32k tokens of state (a 30k
 * paper went in, 43k came back `max_tokens_exceeded`); 64k characters stays under it at 2
 * characters a token.
 */
export const CHUNK = 64_000;
/** Calls per page at most: a longer page is judged on its first `CHUNK * CHUNKS` characters. */
export const CHUNKS = 4;

const CLASS = choice("What kind of source is this page?", {
  primary_data:
    "the party's own data: a filing, a public price page, a job ad, a dataset, a government statistic",
  survey: "a survey or study of many respondents or firms",
  practitioner: "one person who does the work, telling what they saw or did",
  vendor: "a company writing about its own market, product or customers",
  forum: "a forum thread or its comments: Reddit, a Facebook group, a Q&A site",
  news: "a news or trade press article",
  other: "anything else",
} satisfies Record<SourceClass, string>);

const FORMAT = choice("What shape of content is this page?", {
  video: "a video, or a video's page",
  post: "a social post: LinkedIn, X, Instagram, TikTok, Threads, Facebook",
  thread: "a forum thread or a Q&A page",
  article: "an article, a blog post or a newsletter issue",
  paper: "a paper, a report or a study",
  list: "a list of tools, tips or links",
  sales_page: "a product, service, pricing or landing page",
  directory: "a directory, a search page or a profile page",
  docs: "documentation or a help page",
  other: "anything else",
});

/** Labels on a hit, from its title and snippet: no quality call. */
export const HIT_QUESTIONS = {
  format: FORMAT,
  side: choice("Who wrote this page, next to the people the ask is about?", {
    subject: "those people, or a neutral party reporting on them",
    seller: "a vendor, agency or coach selling to those people",
    other: "neither, or it cannot tell",
  }),
  class: CLASS,
} satisfies Questions;

/** Labels on a page read whole, in parts. The `worth` trial (10-28) ended 11-03: no quality call. */
export const DOCUMENT_QUESTIONS = {
  class: CLASS,
  format: FORMAT,
} satisfies Questions;

export const FINDING_QUESTIONS = {
  backs: noul(
    "Does the quote, read in its context, say everything the sentence says? A plain rewording is fine.",
    {
      true: "the quote backs every part of the sentence",
      false:
        "the sentence says more than the quote (a number, a cause, a scope, a certainty, who says it), or the context turns the quote (a question, a hypothetical, an ad)",
    },
  ),
  cites: noul(
    "Does the quote or the text around it credit the fact to another named source: a survey, a study, a report, a dataset?",
  ),
} satisfies Questions;

/** The names the judge asks on its own: a criterion may not take one. */
export const RESERVED: ReadonlySet<string> = new Set([
  ...Object.keys(HIT_QUESTIONS),
  ...Object.keys(DOCUMENT_QUESTIONS),
  ...Object.keys(FINDING_QUESTIONS),
]);

/** The ask's criteria as yes-or-no questions, by name. */
export const criteriaQuestions = (criteria: readonly Criterion[] | undefined): Questions =>
  Object.fromEntries((criteria ?? []).map((c) => [c.name, noul(c.question)]));

/** The body in judge-sized parts, each cut at a paragraph when one is near the limit. */
export function chunksOf(text: string): string[] {
  const out: string[] = [];
  let rest = bodyOf(text);
  while (rest.trim() && out.length < CHUNKS) {
    if (rest.length <= CHUNK) {
      out.push(rest);
      break;
    }
    const cut = rest.lastIndexOf("\n\n", CHUNK);
    const at = cut > CHUNK * 0.8 ? cut : CHUNK;
    out.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  return out;
}

/**
 * One record's answers from its parts: a yes-or-no question takes the part most sure of a yes
 * (a result sits in one section); a pick takes the first part's (the page's start says its kind).
 */
export function mergeAnswers(parts: readonly Judged["answers"][]): Judged["answers"] {
  const out: Record<string, Probs> = { ...parts[0] };
  for (const part of parts.slice(1))
    for (const [k, probs] of Object.entries(part)) {
      const was = out[k];
      if (!was) out[k] = probs;
      else if (probs.yes !== undefined && was.yes !== undefined && probs.yes > was.yes)
        out[k] = probs;
    }
  return out;
}

export interface Pass {
  judged: number;
  failed: number;
  /** Why the pass stopped early: a refused key. */
  stopped?: string;
}

/**
 * One question set over many items, a few at a time; each item's answers one `judge` record.
 * An item in parts (a long page) is asked part by part and written only when every part answered:
 * a missing part would read as a no, so the next pass asks again.
 */
async function pass(
  ctx: StepContext,
  items: readonly { on: string; about: string; states: readonly EntryType[] }[],
  questions: Questions,
): Promise<Pass> {
  const out: Pass = { judged: 0, failed: 0 };
  if (!ctx.deps.judge) return out;
  const askAll = async (x: (typeof items)[number]) => {
    const parts: Judged["answers"][] = [];
    let model = "";
    for (const state of x.states) {
      const g = await ctx.judge(x.on, x.about, state, questions);
      if ("failure" in g) return { failure: g.failure };
      parts.push(g.answers as Judged["answers"]);
      model = g.model;
    }
    return { answers: mergeAnswers(parts), model };
  };
  for (let i = 0; i < items.length && !out.stopped; i += JUDGE_PARALLEL) {
    const batch = items.slice(i, i + JUDGE_PARALLEL);
    const got = await Promise.all(batch.map(askAll));
    for (const [j, g] of got.entries()) {
      const item = batch[j] as (typeof batch)[number];
      if ("failure" in g) {
        out.failed++;
        if (g.failure === "key") out.stopped = `the judge's key was refused`;
        continue;
      }
      await ctx.write(
        { type: "judge", on: item.on, answers: g.answers },
        { from: "ai", by: g.model },
      );
      out.judged++;
    }
  }
  return out;
}

/** "jev: 12 judged, 1 failed" for a step's note, or nothing. */
export const passNote = (p: Pass): string =>
  p.judged || p.failed
    ? `; judge: ${p.judged} judged${p.failed ? `, ${p.failed} failed` : ""}${p.stopped ? ` (${p.stopped})` : ""}`
    : "";

/** Uncalled hits with no answers yet: format, whose side, what class, each criterion. */
export function judgeHits(ctx: StepContext, state: RunState): Promise<Pass> {
  const ask = state.snapshot?.ask.text ?? "";
  const whyOf = new Map(state.queries.map((q) => [q.id, q.why]));
  const items = state.hits
    .filter((h: HitRecord) => !state.judged.has(h.id) && !state.called.has(h.id))
    .map((h) => ({
      on: h.id,
      about: h.url,
      states: [
        {
          ask,
          searched_for: [...new Set(h.queries.flatMap((q) => whyOf.get(q) ?? []))],
          page: { url: h.url, title: h.title ?? "", snippet: h.snippet ?? "" },
        },
      ],
    }));
  return pass(ctx, items, { ...HIT_QUESTIONS, ...criteriaQuestions(state.snapshot?.ask.criteria) });
}

/** Documents with no answers yet: class, format and each criterion, read whole in parts. */
export function judgeDocuments(ctx: StepContext, state: RunState): Promise<Pass> {
  const ask = state.snapshot?.ask.text ?? "";
  const items = state.documents
    .filter((d: DocumentRecord) => !state.judged.has(d.id) && d.text.trim())
    .map((d) => {
      const parts = chunksOf(d.text);
      return {
        on: d.id,
        about: d.url,
        states: parts.map((text, i) => ({
          ask,
          url: d.url,
          title: d.title ?? "",
          ...(parts.length > 1 ? { part: `${i + 1} of ${parts.length}` } : {}),
          text,
        })),
      };
    });
  return pass(ctx, items, {
    ...DOCUMENT_QUESTIONS,
    ...criteriaQuestions(state.snapshot?.ask.criteria),
  });
}

/** Findings with a quote and no answers yet: does the quote back it, does it credit a source. */
export function judgeFindings(
  ctx: StepContext,
  state: RunState,
  findings: readonly FindingRecord[],
): Promise<Pass> {
  const docs = new Map(state.documents.map((d) => [d.id, d]));
  const items = findings.flatMap((f) => {
    const d = docs.get(f.document);
    const quote = f.proof.quote;
    if (!d || !quote || state.judged.has(f.id)) return [];
    return [
      {
        on: f.id,
        about: f.text,
        states: [{ sentence: f.text, quote, context: contextOf(d.text, quote) }],
      },
    ];
  });
  return pass(ctx, items, FINDING_QUESTIONS);
}

/** The probability of a yes on one record's question, or undefined with no answer. */
export const yesOf = (state: RunState, on: string, question: string): number | undefined =>
  state.judged.get(on)?.[question]?.yes;

/** The judge's top label on a question, with its probability. */
export function pickOf(
  state: RunState,
  on: string,
  question: string,
): { pick: string; p: number } | undefined {
  const probs = state.judged.get(on)?.[question];
  if (!probs) return undefined;
  const [pick, p] = top(probs);
  return { pick, p };
}

/**
 * A hit's class as best known: the agent's on its document, else the judge's on the document,
 * else the judge's on the hit.
 */
export function classGuess(state: RunState, hit: string): SourceClass | undefined {
  const doc = state.documents.find((d) => d.hit === hit);
  const agent = doc && state.classOf.get(doc.id);
  if (agent) return agent;
  const guess = (doc && pickOf(state, doc.id, "class")) ?? pickOf(state, hit, "class");
  return guess && (SOURCE_CLASSES as readonly string[]).includes(guess.pick)
    ? (guess.pick as SourceClass)
    : undefined;
}

/**
 * How well a score ranks positives over negatives: the share of (positive, negative) pairs it
 * orders right, ties a half. Null without both.
 */
export function aucOf(pairs: readonly [number, boolean][]): number | null {
  const pos = pairs.filter(([, y]) => y).map(([p]) => p);
  const neg = pairs.filter(([, y]) => !y).map(([p]) => p);
  if (!pos.length || !neg.length) return null;
  let sum = 0;
  for (const a of pos) for (const b of neg) sum += a > b ? 1 : a === b ? 0.5 : 0;
  return sum / (pos.length * neg.length);
}

/** Where the judge and a decider both spoke: how often they agree. */
export interface Agreement {
  both: number;
  agree: number;
}

export interface JudgeStats {
  /** The judge's id, or why there is none. */
  judge: string | null;
  calls: number;
  failed: number;
  usd: number;
  /** Its class guess against the agent's class on a document. */
  classes: Agreement;
  /** Backs the sentence (yes over a half) against the model's check. */
  checks: Agreement & {
    /** Findings it doubted (under DOUBT) that a check read, and how many of those failed. */
    doubted: number;
    doubtedFailed: number;
  };
  /**
   * Each criterion against "a finding on the page was kept", on pages read for facts: asked on
   * the hit (its snippet, an abstract) and on the page read whole. Which one ranks better says
   * how far to trust it.
   */
  criteria: Record<string, { hits: Ranked; pages: Ranked }>;
}

/** A score's pairs and how well it ranks them: against a kept finding, and against a rich verdict. */
export interface Ranked {
  both: number;
  auc: number | null;
  rich: number | null;
}

/** What the judge did in a run and how often the deciders agreed with it. */
export function judgeStats(state: RunState, judge: string | null): JudgeStats {
  const ids = new Set(state.judges.map((j) => j.by));
  const spends = state.spends.filter(
    (s) => s.op === "ask" && (ids.has(s.source) || s.source === judge),
  );
  const tally = (pairs: [boolean, boolean][]): Agreement => ({
    both: pairs.length,
    agree: pairs.filter(([a, b]) => a === b).length,
  });
  const classes = state.documents.flatMap((d): [boolean, boolean][] => {
    const guess = pickOf(state, d.id, "class");
    const agent = state.classOf.get(d.id);
    return !guess || !agent ? [] : [[true, guess.pick === agent]];
  });
  const lastCheck = new Map(state.checks.map((c) => [c.on, c.ok]));
  const checks = [...lastCheck].flatMap(([on, ok]): [boolean, boolean][] => {
    const yes = yesOf(state, on, "backs");
    return yes === undefined ? [] : [[yes > 0.5, ok]];
  });
  const keptOn = new Set(state.findings.filter((f) => kept(state, f)).map((f) => f.document));
  // Read for facts: an extract's verdict, a finding by hand, or a gap on the page.
  const extracted = new Set([
    ...state.verdicts.map((v) => v.document),
    ...state.findings.map((f) => f.document),
    ...state.gaps.flatMap((g) => (g.on ? [g.on] : [])),
  ]);
  // the last verdict per page: a rerun extract replaces the first
  const quality = new Map(state.verdicts.map((v) => [v.document, v.quality]));
  const hitOf = new Map(state.documents.map((d) => [d.id, d.hit]));
  const scored = (name: string, on: (d: string) => string | undefined) =>
    [...extracted].flatMap((d): [number, string][] => {
      const id = on(d);
      const yes = id === undefined ? undefined : yesOf(state, id, name);
      return yes === undefined ? [] : [[yes, d]];
    });
  const ranked = (pairs: readonly [number, string][]): Ranked => ({
    both: pairs.length,
    auc: aucOf(pairs.map(([p, d]) => [p, keptOn.has(d)])),
    rich: aucOf(
      pairs.flatMap(([p, d]) => (quality.has(d) ? [[p, quality.get(d) === "rich"]] : [])),
    ),
  });
  const criteria = Object.fromEntries(
    (state.snapshot?.ask.criteria ?? []).map((c) => [
      c.name,
      {
        hits: ranked(scored(c.name, (d) => hitOf.get(d))),
        pages: ranked(scored(c.name, (d) => d)),
      },
    ]),
  );
  const doubted = [...lastCheck].filter(([on]) => (yesOf(state, on, "backs") ?? 1) < DOUBT);
  return {
    judge,
    calls: spends.length,
    failed: spends.filter((s) => !s.ok).length,
    usd: spends.reduce((a, s) => a + (s.usd ?? 0), 0),
    classes: tally(classes),
    checks: {
      ...tally(checks),
      doubted: doubted.length,
      doubtedFailed: doubted.filter(([, ok]) => !ok).length,
    },
    criteria,
  };
}
