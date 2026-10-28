/**
 * After a round: stop, go again from plan, or back to one step. The model decides and says why;
 * the round budget is a guard rail it sees (`{round}` of `{rounds}`), never a stop rule. The
 * runner takes the edge and parks past the budget; raven never loops.
 */
import type { Model } from "@wrenautomation/models";
import { fill } from "./model.js";
import { ageOf, defaultPlanFile } from "./plans/index.js";
import { lines, renderAge, renderSteer } from "./render.js";
import { type Edge, type PlanFile, type Round, Step, type Verdict, z } from "./types.js";

const EdgeAnswer = z.object({
  next: z.enum(["stop", "again", "back"]),
  to: Step.optional(),
  why: z.string(),
});

const verdictLine = (v: Verdict): string => `${v.url}: ${v.quality}${v.gap ? `. ${v.gap}` : ""}`;

export function reviewPrompt(round: Round, planFile: PlanFile): string {
  return fill(planFile.review, {
    ask: round.ask.text,
    steer: renderSteer(round.ask.steer),
    round: String(round.round),
    rounds: String(round.budget.rounds),
    hits: String(round.hits),
    reads: String(round.reads),
    proposed: String(round.proposed),
    kept: String(round.kept),
    found: lines(round.found),
    notes: lines(round.notes, "(none)"),
    gaps: lines(round.gaps, "(none)"),
    checks: lines(round.checks, "(none)"),
    age: renderAge(ageOf(planFile)),
    verdicts: lines(round.verdicts.map(verdictLine), "(none)"),
  });
}

export async function review(
  round: Round,
  model: Model,
  options: { planFile?: PlanFile } = {},
): Promise<Edge> {
  const planFile = options.planFile ?? defaultPlanFile(round.ask.kind);
  const { value: out } = await model.ask(reviewPrompt(round, planFile), EdgeAnswer);
  const edge: Edge = { next: out.next, why: out.why, from: "ai", by: model.id };
  if (out.next === "back") edge.to = out.to ?? "fetch";
  return edge;
}
