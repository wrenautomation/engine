/**
 * The filter before the read: for each hit, read or skip, from what the hit shows for free.
 * Hits dedupe by url and keep every source that returned them. The model picks; the read budget
 * caps it; a hit the model did not name is a skip, written down as one.
 */
import { fill, type Model } from "./model.js";
import { defaultPlanFile } from "./plans/index.js";
import { lines, renderHits, renderYield } from "./render.js";
import { type HitView, type Plan, type PlanFile, type Triage, type YieldRow, z } from "./types.js";

const TriageAnswer = z.object({
  hits: z.array(z.object({ url: z.string(), read: z.boolean(), why: z.string() })),
});

/** One hit per url, sources merged, order of first sight. */
export function dedupeHits(hits: readonly HitView[]): HitView[] {
  const byUrl = new Map<string, HitView>();
  for (const h of hits) {
    const url = h.url.trim();
    const have = byUrl.get(url);
    if (!have) {
      byUrl.set(url, { ...h, url, sources: [...new Set(h.sources)] });
      continue;
    }
    for (const s of h.sources) if (!have.sources.includes(s)) have.sources.push(s);
    for (const k of ["title", "channel", "length", "date", "snippet"] as const) {
      if (have[k] === undefined && h[k] !== undefined) (have as Record<string, unknown>)[k] = h[k];
    }
  }
  return [...byUrl.values()];
}

export function triagePrompt(
  hits: readonly HitView[],
  plan: Plan,
  planFile: PlanFile,
  yieldRows: readonly YieldRow[],
): string {
  return fill(planFile.triage, {
    n: String(plan.budget.reads),
    ask: plan.ask.text,
    site: plan.ask.site ?? "",
    known: lines(plan.ask.known),
    yield: renderYield(yieldRows),
    hits: renderHits(hits),
  });
}

/** Read or skip per hit, with why. Reads over the plan's budget flip to skips, in the model's order. */
export async function triage(
  hits: readonly HitView[],
  plan: Plan,
  model: Model,
  options: { planFile?: PlanFile; yieldRows?: readonly YieldRow[] } = {},
): Promise<Triage[]> {
  const unique = dedupeHits(hits);
  if (!unique.length) return [];
  const planFile = options.planFile ?? defaultPlanFile(plan.ask.kind);
  const out = await model.ask(
    triagePrompt(unique, plan, planFile, options.yieldRows ?? []),
    TriageAnswer,
  );
  const said = new Map(out.hits.map((h) => [h.url.trim(), h]));
  let reads = 0;
  return unique.map((h) => {
    const a = said.get(h.url);
    const base = { url: h.url, from: "ai" as const, by: model.id };
    if (!a) return { ...base, read: false, why: "not named by the model" };
    if (!a.read) return { ...base, read: false, why: a.why };
    if (reads >= plan.budget.reads)
      return { ...base, read: false, why: `over the read budget (${plan.budget.reads})` };
    reads++;
    return { ...base, read: true, why: a.why };
  });
}
