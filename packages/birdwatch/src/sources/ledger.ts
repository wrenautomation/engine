/**
 * The ledger as a source: hits earlier runs saw whose title or snippet holds every word of the
 * query. A run that starts where the last one got to. Free.
 */
import type { Source } from "../engine/ports.js";
import type { Ledger } from "../ledger/ledger.js";
import { ofType } from "../ledger/ledger.js";

const wordsOf = (s: string) =>
  s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2);

export function ledgerSource(ledger: Ledger, n = 10): Source {
  return {
    name: "ledger",
    kind: "search",
    cost: "free",
    async search(q) {
      const want = wordsOf(q.terms);
      if (!want.length) return [];
      const hits = ofType(await ledger.scan({ type: "hit" }), "hit").filter((h) => h.run !== q.run);
      const out = new Map<string, (typeof hits)[number]>();
      for (const h of hits) {
        const have = new Set(wordsOf(`${h.title ?? ""} ${h.snippet ?? ""}`));
        if (want.every((w) => have.has(w)) && !out.has(h.key)) out.set(h.key, h);
      }
      return [...out.values()]
        .slice(0, n)
        .map(({ url, title, channel, length, date, snippet }) => ({
          url,
          ...(title ? { title } : {}),
          ...(channel ? { channel } : {}),
          ...(length !== undefined ? { length } : {}),
          ...(date ? { date } : {}),
          ...(snippet ? { snippet } : {}),
        }));
    },
  };
}
