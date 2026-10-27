/**
 * A claim as the synthesis reader sees it: one sentence that quotes one page. The research
 * engine's `claimExtractor` (`./document`) draws claims out of a document; a study's drafts and
 * report (`./drafts`, `./report`) cite them by number. The planner that lived here (queries per
 * angle, which pages to read, the claim gate per angle) went in 0.5.0: raven plans, weaver runs.
 */

export interface Claim {
  /** The angle it answers: its index in the study's angles. */
  angle: number;
  claim: string;
  quote: string;
  source_url: string;
}

/**
 * `{name}` marks filled in one pass: a "{angle}" or "$&" inside a question or
 * a page stays text.
 */
export const fill = (template: string, values: Readonly<Record<string, string>>): string =>
  template.replace(/\{(\w+)\}/g, (mark, name: string) => values[name] ?? mark);
