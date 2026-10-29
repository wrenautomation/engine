/**
 * After a round: stop, go again from plan, or back to one step. The model decides and says why;
 * the round budget is a guard rail it sees (`{round}` of `{rounds}`), never a stop rule. The
 * runner takes the edge and parks past the budget; the planner never loops.
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

/** A count with the earlier rounds' after it: rides the `{hits}` and `{kept}` slots, so a stored plan file shows it too. */
const trend = (now: string, before: number[]): string =>
  before.length ? `${now} (earlier rounds: ${before.join(", ")})` : now;

export function reviewPrompt(round: Round, planFile: PlanFile): string {
  return fill(planFile.review, {
    ask: round.ask.text,
    steer: renderSteer(round.ask),
    round: String(round.round),
    rounds: String(round.budget.rounds),
    hits: trend(
      `${round.hits} new`,
      round.earlier.map((e) => e.hits),
    ),
    reads: String(round.reads),
    proposed: String(round.proposed),
    kept: trend(
      String(round.kept),
      round.earlier.map((e) => e.kept),
    ),
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
