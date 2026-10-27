/**
 * After a round: stop, go again from plan, or back to one step. The round budget is a guard
 * rail, not a stop rule: when it is spent raven stops and says so; before that the model decides
 * and says why. The runner takes the edge; raven never loops.
 */
import { fill, type Model } from "./model.js";
import { defaultPlanFile } from "./plans/index.js";
import { lines } from "./render.js";
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
    round: String(round.round),
    rounds: String(round.budget.rounds),
    hits: String(round.hits),
    reads: String(round.reads),
    proposed: String(round.proposed),
    kept: String(round.kept),
    found: lines(round.found),
    notes: lines(round.notes, "(none)"),
    verdicts: lines(round.verdicts.map(verdictLine), "(none)"),
  });
}

export async function review(
  round: Round,
  model: Model,
  options: { planFile?: PlanFile } = {},
): Promise<Edge> {
  if (round.round >= round.budget.rounds) {
    return {
      next: "stop",
      why: `round budget spent (${round.round} of ${round.budget.rounds})`,
      from: "ai",
      by: "raven:budget",
    };
  }
  const planFile = options.planFile ?? defaultPlanFile(round.ask.kind);
  const { value: out } = await model.ask(reviewPrompt(round, planFile), EdgeAnswer);
  const edge: Edge = { next: out.next, why: out.why, from: "ai", by: model.id };
  if (out.next === "back") edge.to = out.to ?? "fetch";
  return edge;
}
