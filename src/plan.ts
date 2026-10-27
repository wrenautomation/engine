/**
 * The plan step: proposals in, one plan out. The model is one proposer; a person, a plan file
 * or a second model are others, and all merge the same way. Human queries come first and never
 * count against the budget: someone chose them.
 */
import { fill, type Model } from "./model.js";
import { defaultPlanFile } from "./plans/index.js";
import { lines, renderYield } from "./render.js";
import {
  type Ask,
  type Plan,
  type PlanFile,
  type Proposal,
  type Query,
  type YieldRow,
  z,
} from "./types.js";

const ProposalAnswer = z.object({
  queries: z.array(z.object({ terms: z.string(), why: z.string(), site: z.string().optional() })),
});

export function proposePrompt(
  ask: Ask,
  planFile: PlanFile,
  yieldRows: readonly YieldRow[],
  now: Date,
): string {
  return fill(planFile.propose, {
    n: String(planFile.budget.queries),
    year: String(now.getUTCFullYear()),
    ask: ask.text,
    site: ask.site ?? "",
    known: lines(ask.known),
    yield: renderYield(yieldRows),
  });
}

/** The model's proposal for an ask under a plan file. */
export async function propose(
  ask: Ask,
  planFile: PlanFile,
  model: Model,
  yieldRows: readonly YieldRow[] = [],
  now: Date = new Date(),
): Promise<Proposal> {
  const out = await model.ask(proposePrompt(ask, planFile, yieldRows, now), ProposalAnswer);
  return {
    from: "ai",
    by: model.id,
    queries: out.queries.map((q) => {
      const site = q.site ?? ask.site;
      return { kind: ask.kind, terms: q.terms, why: q.why, ...(site ? { site } : {}) };
    }),
  };
}

const key = (q: { terms: string; site?: string | undefined }): string =>
  `${q.site?.toLowerCase() ?? ""}|${q.terms.replace(/\s+/g, " ").trim().toLowerCase()}`;

/**
 * One list from many proposals. Human proposals first, then the rest in the order given; the
 * same terms twice keep the first. At most `cap` AI queries; human queries all stay.
 */
export function mergeProposals(proposals: readonly Proposal[], cap: number): Query[] {
  const ordered = [
    ...proposals.filter((p) => p.from === "human"),
    ...proposals.filter((p) => p.from !== "human"),
  ];
  const seen = new Set<string>();
  const out: Query[] = [];
  let ai = 0;
  for (const p of ordered) {
    for (const q of p.queries) {
      const terms = q.terms.replace(/\s+/g, " ").trim();
      if (!terms || seen.has(key(q))) continue;
      if (p.from !== "human") {
        if (ai >= cap) continue;
        ai++;
      }
      seen.add(key(q));
      out.push({ ...q, terms, from: p.from, by: p.by });
    }
  }
  return out;
}

export interface PlanInput {
  ask: Ask;
  /** The default for the ask's kind when absent. */
  planFile?: PlanFile;
  /** No model: the plan is the proposals given, nothing proposed. */
  model?: Model | null;
  /** From people, plan files or other models. Merged with the model's. */
  proposals?: readonly Proposal[];
  yieldRows?: readonly YieldRow[];
  /** Narrows the plan file's sources for this run. Names not in the plan file are dropped. */
  sources?: readonly string[];
  round?: number;
  now?: () => Date;
}

/** The plan for one round: what to look for, where, under what budget, and what raven was given. */
export async function plan(input: PlanInput): Promise<Plan> {
  const planFile = input.planFile ?? defaultPlanFile(input.ask.kind);
  const now = input.now?.() ?? new Date();
  const yieldRows = input.yieldRows ?? [];
  const proposals = [...(input.proposals ?? [])];
  if (input.model) proposals.push(await propose(input.ask, planFile, input.model, yieldRows, now));
  const sources = input.sources
    ? planFile.sources.filter((s) => input.sources?.includes(s))
    : [...planFile.sources];
  return {
    ask: input.ask,
    round: input.round ?? 1,
    queries: mergeProposals(proposals, planFile.budget.queries),
    sources,
    budget: planFile.budget,
    snapshot: {
      at: now.toISOString(),
      known: [...input.ask.known],
      planFile: { id: planFile.id, version: planFile.version },
      model: input.model?.id ?? null,
      yieldRows: yieldRows.length,
    },
  };
}
