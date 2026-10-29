/**
 * A person's URLs as a source: the hits they pasted come back on the first search of a run,
 * marked `from: human` and `by` them. Every query after that gets nothing: the list was given
 * once.
 */

import type { Source } from "../engine/ports.js";
import type { HitViewIn } from "../engine/types.js";

export function paste(hits: readonly HitViewIn[], by: string): Source {
  let given = false;
  return {
    name: "paste",
    kind: "search",
    cost: "free",
    from: "human",
    by,
    async search() {
      if (given) return [];
      given = true;
      return hits.map((h) => ({ ...h }));
    },
  };
}
