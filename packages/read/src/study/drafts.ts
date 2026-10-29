/**
 * A study's claims turned into something to use: offer candidates, cold
 * emails, a brief. The model sees only the numbered claims, never the pages,
 * so a draft is two steps from a quote: draft cites claim, claim quotes page.
 * An item that cites nothing, cites a claim that isn't there, or has a number
 * no cited claim (or the task) gave it, is dropped.
 */
import { z } from "zod";
import { type Claim, fill } from "./claims.js";
import { numbers } from "./grounding.js";

/** One draft a study writes from its claims: its key in the report and what to ask for. */
export interface StudyDraftSpec {
  key: string;
  ask: string;
}

const DRAFT_ITEMS_MAX = 8;

const DRAFT = `You turn research into something a small business can use. Use ONLY the numbered claims below: they are everything we know.

Return ONLY a JSON object, no prose, exactly this shape:
{"items": [{"title": "...", "body": "...", "cites": [1, 4]}]}

Rules:
- cites: the numbers of the claims the item rests on. At least one.
- No citation marks like [1] or (claim 1) in the title or body: cites carries them.
- Every number in the title or body must appear in a claim it cites, or in the task.
- Never invent a statistic, a client, a result, a quote or a price. We have no clients yet: never say what clients or owners "tell us".
- Plain words a person says out loud. No dashes as punctuation.

TASK:
{ask}

Study: {question}

CLAIMS:
{claims}
`;

export const DraftProposals = z.object({
  items: z.array(
    z.object({
      title: z.string().nullable().optional(),
      body: z.string().nullable().optional(),
      cites: z.array(z.coerce.number()).nullable().optional(),
    }),
  ),
});
export type DraftProposals = z.infer<typeof DraftProposals>;

/** A claim as drafts see it: its report number. */
export interface NumberedClaim extends Claim {
  n: number;
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

export function buildDraftPrompt(
  question: string,
  spec: StudyDraftSpec,
  claims: readonly NumberedClaim[],
): string {
  return fill(DRAFT, {
    ask: spec.ask,
    question,
    claims: claims.map((c) => `[${c.n}] ${c.claim} (${hostOf(c.source_url)})`).join("\n"),
  });
}

export interface DraftItem {
  title: string;
  body: string;
  cites: number[];
}

type DraftRejection = "empty" | "no_cites" | "unknown_cite" | "number_not_cited";

export interface DroppedDraft {
  title: string;
  why: DraftRejection;
}

/** "[3]", "[1, 4]", "(claim 2)", "(claims 1 and 5)": the model's citation marks, not text. */
const CITE_MARK =
  /\s*(?:\[\d+(?:\s*,\s*\d+)*\]|\((?:claims?|sources?)\s*\d+(?:\s*(?:,|and|&)\s*\d+)*\))/gi;

const stripCiteMarks = (s: string): string =>
  s
    .replace(CITE_MARK, "")
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .trim();

/** Every item through the gate: kept (citation marks stripped), or dropped with why. */
export function gateDrafts(
  proposals: DraftProposals,
  spec: StudyDraftSpec,
  claims: readonly NumberedClaim[],
): { kept: DraftItem[]; dropped: DroppedDraft[] } {
  const byN = new Map(claims.map((c) => [c.n, c]));
  const fromTask = new Set(numbers(spec.ask));
  const kept: DraftItem[] = [];
  const dropped: DroppedDraft[] = [];
  for (const p of proposals.items.slice(0, DRAFT_ITEMS_MAX)) {
    const title = stripCiteMarks(p.title ?? "");
    const body = stripCiteMarks(p.body ?? "");
    const cites = [...new Set(p.cites ?? [])];
    const why: DraftRejection | null = !body
      ? "empty"
      : !cites.length
        ? "no_cites"
        : cites.some((n) => !byN.has(n))
          ? "unknown_cite"
          : null;
    if (why) {
      dropped.push({ title, why });
      continue;
    }
    const cited = new Set(
      cites.flatMap((n) => {
        const c = byN.get(n);
        return c ? numbers(`${c.claim} ${c.quote}`) : [];
      }),
    );
    if (numbers(`${title} ${body}`).some((n) => !cited.has(n) && !fromTask.has(n))) {
      dropped.push({ title, why: "number_not_cited" });
      continue;
    }
    kept.push({ title, body, cites: cites.sort((a, b) => a - b) });
  }
  return { kept, dropped };
}
