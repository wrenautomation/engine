/**
 * The judge's passes: cheap typed answers on every hit, document and finding, written as
 * `judge` records. A hint and a router, never a call: the brief ranks hits and shows class
 * guesses by them, the tree counts a facet's needed classes by them before a read, and the
 * check sends each finding the judge doubts to the model. A failed judge call writes its spend
 * and the step goes on; a refused key ends the pass.
 */
import { contextOf } from "@wrenautomation/falcon/document";
import {
  choice,
  type EntryType,
  type Judged,
  noul,
  type Questions,
  top,
} from "@wrenautomation/models/judge";
import {
  type DocumentRecord,
  type FindingRecord,
  type HitRecord,
  SOURCE_CLASSES,
  type SourceClass,
} from "../ledger/records.js";
import type { RunState } from "./state.js";
import type { StepContext } from "./steps.js";

/** Judge calls in flight at once. */
export const JUDGE_PARALLEL = 8;
/** A finding the judge backs under this goes to the model's check. */
export const DOUBT = 0.8;
/** Characters of a page's start the judge reads for its class. */
const HEAD = 4000;

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

export const HIT_QUESTIONS = {
  serves: noul(
    "Could this page hold a specific fact (a number, a practice, a stated cause) that answers the ask?",
    {
      true: "it likely holds such a fact",
      false: "another topic, or nothing specific: a listicle, a directory, a sales page",
    },
  ),
  side: choice("Who wrote this page, next to the people the ask is about?", {
    subject: "those people, or a neutral party reporting on them",
    seller: "a vendor, agency or coach selling to those people",
    other: "neither, or it cannot tell",
  }),
  class: CLASS,
} satisfies Questions;

export const DOCUMENT_QUESTIONS = { class: CLASS } satisfies Questions;

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

export interface Pass {
  judged: number;
  failed: number;
  /** Why the pass stopped early: a refused key. */
  stopped?: string;
}

/** One question set over many items, a few at a time; each answer a `judge` record. */
async function pass(
  ctx: StepContext,
  items: readonly { on: string; about: string; state: EntryType }[],
  questions: Questions,
): Promise<Pass> {
  const out: Pass = { judged: 0, failed: 0 };
  if (!ctx.deps.judge) return out;
  for (let i = 0; i < items.length && !out.stopped; i += JUDGE_PARALLEL) {
    const batch = items.slice(i, i + JUDGE_PARALLEL);
    const got = await Promise.all(batch.map((x) => ctx.judge(x.on, x.about, x.state, questions)));
    for (const [j, g] of got.entries()) {
      const item = batch[j] as (typeof batch)[number];
      if ("failure" in g) {
        out.failed++;
        if (g.failure === "key") out.stopped = `the judge's key was refused`;
        continue;
      }
      await ctx.write(
        { type: "judge", on: item.on, answers: g.answers as Judged["answers"] },
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

/** Uncalled hits with no answers yet: serves the ask, whose side, what class. */
export function judgeHits(ctx: StepContext, state: RunState): Promise<Pass> {
  const ask = state.snapshot?.ask.text ?? "";
  const whyOf = new Map(state.queries.map((q) => [q.id, q.why]));
  const items = state.hits
    .filter((h: HitRecord) => !state.judged.has(h.id) && !state.called.has(h.id))
    .map((h) => ({
      on: h.id,
      about: h.url,
      state: {
        ask,
        searched_for: [...new Set(h.queries.flatMap((q) => whyOf.get(q) ?? []))],
        page: { url: h.url, title: h.title ?? "", snippet: h.snippet ?? "" },
      },
    }));
  return pass(ctx, items, HIT_QUESTIONS);
}

/** Documents with no answers yet: their class from the page's start. */
export function judgeDocuments(ctx: StepContext, state: RunState): Promise<Pass> {
  const items = state.documents
    .filter((d: DocumentRecord) => !state.judged.has(d.id) && d.text.trim())
    .map((d) => ({
      on: d.id,
      about: d.url,
      state: { url: d.url, title: d.title ?? "", text: d.text.slice(0, HEAD) },
    }));
  return pass(ctx, items, DOCUMENT_QUESTIONS);
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
        state: { sentence: f.text, quote, context: contextOf(d.text, quote) },
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
  /** Serves the ask (yes over a half) against the agent's keep or drop. */
  hits: Agreement;
  /** Its class guess against the agent's class on a document. */
  classes: Agreement;
  /** Backs the sentence (yes over a half) against the model's check. */
  checks: Agreement & {
    /** Findings it doubted (under DOUBT) that a check read, and how many of those failed. */
    doubted: number;
    doubtedFailed: number;
  };
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
  const hits = state.hits.flatMap((h): [boolean, boolean][] => {
    const yes = yesOf(state, h.id, "serves");
    const call = state.called.get(h.id);
    return yes === undefined || !call ? [] : [[yes > 0.5, call === "keep"]];
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
  const doubted = [...lastCheck].filter(([on]) => (yesOf(state, on, "backs") ?? 1) < DOUBT);
  return {
    judge,
    calls: spends.length,
    failed: spends.filter((s) => !s.ok).length,
    usd: spends.reduce((a, s) => a + (s.usd ?? 0), 0),
    hits: tally(hits),
    classes: tally(classes),
    checks: {
      ...tally(checks),
      doubted: doubted.length,
      doubtedFailed: doubted.filter(([, ok]) => !ok).length,
    },
  };
}
