/** A `Model` from one `complete`: the request checks and the parse-and-repair `ask` live here once. */
import type { ZodType } from "zod";
import { Unsupported } from "./errors.js";
import { NoAnswer, parseAnswer } from "./parse.js";
import { addUsage } from "./prices.js";
import type { Answer, AskOptions, Model, Part, PartKind, Reply, Request, Usage } from "./types.js";

export const TEXT_ONLY: ReadonlySet<PartKind> = new Set(["text"]);

export const asRequest = (r: Request | string): Request =>
  typeof r === "string" ? { prompt: r } : r;

/** The prompt as plain text when it is only text parts; null when it holds media. */
export function promptText(prompt: string | readonly Part[]): string | null {
  if (typeof prompt === "string") return prompt;
  const texts: string[] = [];
  for (const p of prompt) {
    if (p.type !== "text") return null;
    texts.push(p.text);
  }
  return texts.join("\n\n");
}

/** Throws `Unsupported` for the first part the model does not take. */
export function checkParts(id: string, takes: ReadonlySet<PartKind>, prompt: Request["prompt"]) {
  if (typeof prompt === "string") return;
  for (const p of prompt) if (!takes.has(p.type)) throw new Unsupported(id, p.type);
}

const repairNote = (issues: string) =>
  `Your last answer was not one JSON object of the asked shape${issues ? ` (${issues})` : ""}. Answer again with only that JSON object.`;

/**
 * Parse a reply to the shape; on a miss, ask again with why, up to `repairs` times (default 1).
 * The usage of every call is summed into the answer.
 */
export async function askWith<T>(
  complete: (r: Request) => Promise<Reply>,
  prompt: string | readonly Part[],
  shape: ZodType<T>,
  o: AskOptions = {},
): Promise<Answer<T>> {
  const { repairs = 1, ...rest } = o;
  let usage: Usage | undefined;
  let current = prompt;
  for (let attempt = 0; ; attempt++) {
    const reply = await complete({ ...rest, prompt: current });
    usage = addUsage(usage, reply.usage);
    try {
      return { value: parseAnswer(reply.text, shape), ...(usage ? { usage } : {}) };
    } catch (err) {
      if (!(err instanceof NoAnswer) || attempt >= repairs) throw err;
      const note = `${reply.text}\n\n${repairNote(err.issues)}`;
      current =
        typeof prompt === "string"
          ? `${prompt}\n\nYour last answer:\n${note}`
          : [...prompt, { type: "text", text: `Your last answer:\n${note}` }];
    }
  }
}

/** A full `Model` from its id, vendor, part kinds and one `complete`. */
export function modelOf(o: {
  id: string;
  provider: string;
  takes?: ReadonlySet<PartKind>;
  complete: (r: Request) => Promise<Reply>;
}): Model {
  const takes = o.takes ?? TEXT_ONLY;
  const complete = async (r: Request | string) => {
    const req = asRequest(r);
    checkParts(o.id, takes, req.prompt);
    return o.complete(req);
  };
  return {
    id: o.id,
    provider: o.provider,
    takes,
    complete,
    ask: (prompt, shape, opts) => askWith(complete, prompt, shape, opts),
  };
}
