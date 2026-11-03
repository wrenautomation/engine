import type { MetricKey, Metrics } from "../engine/types.js";

/** `{ metrics }` from the counts given, whole and present; nothing when none is. */
export const metricsOf = (
  counts: Partial<Record<MetricKey, number | null | undefined>>,
): { metrics?: Metrics } => {
  const metrics: Metrics = {};
  for (const [k, v] of Object.entries(counts) as [MetricKey, number | null | undefined][])
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) metrics[k] = Math.round(v);
  return Object.keys(metrics).length ? { metrics } : {};
};
