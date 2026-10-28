/** What a run's spends add up to, for the brief and the run's last line. */
import type { SpendRecord } from "../ledger/records.js";

/** What a run's spends add up to: USD where priced, tokens and calls per model or source. */
export function costOf(spends: readonly SpendRecord[]): {
  total: { usd: number; unpriced: number; input: number; output: number; calls: number };
  line: string;
} {
  let usd = 0;
  let unpriced = 0;
  let input = 0;
  let output = 0;
  const by = new Map<string, { calls: number; input: number; output: number; usd: number }>();
  for (const s of spends) {
    const row = by.get(s.source) ?? { calls: 0, input: 0, output: 0, usd: 0 };
    row.calls++;
    row.input += s.tokens?.input ?? 0;
    row.output += s.tokens?.output ?? 0;
    input += s.tokens?.input ?? 0;
    output += s.tokens?.output ?? 0;
    if (s.usd !== undefined) {
      usd += s.usd;
      row.usd += s.usd;
    } else if (s.cost === "metered") unpriced++;
    by.set(s.source, row);
  }
  const parts = [...by].map(
    ([name, r]) =>
      `${name} ${r.calls} calls` +
      (r.input || r.output ? `, ${r.input} in, ${r.output} out` : "") +
      (r.usd ? `, $${r.usd.toFixed(4)}` : ""),
  );
  const line =
    `$${usd.toFixed(4)}` +
    (unpriced ? ` plus ${unpriced} metered calls with no price` : "") +
    `; ${parts.join("; ")}`;
  return { total: { usd, unpriced, input, output, calls: spends.length }, line };
}
