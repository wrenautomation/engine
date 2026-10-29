/**
 * What earlier runs proved, found again: the findings of every run in the ledger, ranked by
 * MiniSearch (BM25 over the finding's text and quote, prefix and a little fuzz). Each carries its
 * quote, its source's date and its run, so a later run sees how old a fact is and where it came
 * from. A finding a call or a failed check dropped is left out. Read only: the agent decides what
 * still holds, puts it in `known` or reads the source again (WA-934, option A).
 */

import MiniSearch from "minisearch";
import { type Filter, type Ledger, latestCalls, ofType } from "../ledger/ledger.js";
import { byTime } from "../ledger/records.js";
import type { AskKind } from "../plan/index.js";

export interface Recalled {
  finding: string;
  run: string;
  /** The ask of the run that found it. */
  ask: string;
  text: string;
  quote: string;
  url: string;
  /** The source's own date, when its document had one. */
  date: string | null;
  /** When the run found it. */
  found: string;
  /** Who wrote it: the agent's id for a finding it read and added, a model's id for `extract`. */
  by: string;
  /** `kept`: a call kept it; `open`: no call on it yet. Ranking ignores it. */
  state: "kept" | "open";
  /** Other runs that found the same quote on the same page, newest first. */
  alsoIn: string[];
  score: number;
}

export interface RecallOptions {
  /** At most this many; 20 by default. */
  n?: number;
  /** Leave this run out: the one asking. */
  not?: string;
  /** Only runs of this ask kind. */
  kind?: AskKind;
  /** Only these runs: a child's siblings and parent. */
  runs?: readonly string[];
}

/** Several ledgers read as one (a folder per day): their records merged in time order. */
export const joined = (ledgers: readonly Pick<Ledger, "scan">[]): Pick<Ledger, "scan"> => ({
  scan: async (f?: Filter) =>
    (await Promise.all(ledgers.map((l) => l.scan(f)))).flat().sort(byTime),
});

const fold = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

export async function recall(
  ledger: Pick<Ledger, "scan">,
  terms: string,
  o: RecallOptions = {},
): Promise<Recalled[]> {
  if (!terms.trim()) throw new Error("recall needs terms");
  const records = await ledger.scan({ type: ["snapshot", "finding", "call"] });
  const asks = new Map<string, { text: string; kind: AskKind }>();
  for (const s of ofType(records, "snapshot"))
    if (!asks.has(s.run)) asks.set(s.run, { text: s.ask.text, kind: s.ask.kind });
  const calls = latestCalls(records);
  // Newest first, so the first of a quote seen twice is the latest proof of it.
  const findings = ofType(records, "finding")
    .filter((f) => f.run !== o.not && calls.get(f.id) !== "drop")
    .filter((f) => !o.kind || asks.get(f.run)?.kind === o.kind)
    .filter((f) => !o.runs || o.runs.includes(f.run))
    .reverse();
  const byKey = new Map<string, Recalled>();
  for (const f of findings) {
    const quote = f.proof.quote ?? "";
    const key = `${f.proof.url}\u0000${fold(quote)}`;
    const seen = byKey.get(key);
    if (seen) {
      if (f.run !== seen.run && !seen.alsoIn.includes(f.run)) seen.alsoIn.push(f.run);
      continue;
    }
    byKey.set(key, {
      finding: f.id,
      run: f.run,
      ask: asks.get(f.run)?.text ?? "",
      text: f.text,
      quote,
      url: f.proof.url,
      date: f.date ?? null,
      found: f.at,
      by: f.by,
      state: calls.get(f.id) === "keep" ? "kept" : "open",
      alsoIn: [],
      score: 0,
    });
  }
  const index = new MiniSearch<Recalled>({
    idField: "finding",
    fields: ["text", "quote"],
    searchOptions: { boost: { text: 2 }, prefix: true, fuzzy: 0.2 },
  });
  index.addAll([...byKey.values()]);
  const of = new Map([...byKey.values()].map((r) => [r.finding, r]));
  return index
    .search(terms)
    .slice(0, o.n ?? 20)
    .flatMap((hit) => {
      const r = of.get(hit.id as string);
      return r ? [{ ...r, score: Math.round(hit.score * 100) / 100 }] : [];
    });
}
