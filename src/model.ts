/**
 * The model seam. Raven never picks a model: a caller hands in one `Model`, a function from a
 * prompt and an answer shape to a parsed answer, and its id goes on every record it writes. In
 * a terminal the model is a command that reads the prompt on stdin and prints the answer
 * (`claude -p` by default); in wren it wraps the LLM client.
 */
import { spawn } from "node:child_process";
import type { ZodType } from "zod";

export interface Model {
  /** What goes in `by` on the records this model writes. */
  id: string;
  ask<T>(prompt: string, shape: ZodType<T>): Promise<T>;
}

/** `{name}` marks filled in one pass; a `{word}` with no value stays as text. */
export const fill = (template: string, values: Readonly<Record<string, string>>): string =>
  template.replace(/\{(\w+)\}/g, (mark, name: string) => values[name] ?? mark);

/**
 * The first JSON object in a model's text, parsed into the shape. Fences and prose around
 * it are dropped. Throws with the model's text when nothing parses.
 */
export function parseAnswer<T>(text: string, shape: ZodType<T>): T {
  const start = text.indexOf("{");
  if (start >= 0) {
    for (let end = text.lastIndexOf("}"); end > start; end = text.lastIndexOf("}", end - 1)) {
      try {
        const out = shape.safeParse(JSON.parse(text.slice(start, end + 1)));
        if (out.success) return out.data;
      } catch {}
    }
  }
  throw new Error(`no answer of the expected shape in: ${text.slice(0, 400)}`);
}

/**
 * A model that is a shell command: the prompt on stdin, the answer on stdout. `claude -p`
 * makes Claude Code the planner's model from any terminal.
 */
export function commandModel(command: string, id = command): Model {
  return {
    id,
    ask: (prompt, shape) =>
      new Promise((resolve, reject) => {
        const child = spawn(command, { shell: true, stdio: ["pipe", "pipe", "inherit"] });
        const out: Buffer[] = [];
        child.stdout.on("data", (b: Buffer) => out.push(b));
        child.on("error", reject);
        child.on("close", (code) => {
          const text = Buffer.concat(out).toString("utf8");
          if (code !== 0)
            return reject(new Error(`${command} exited ${code}: ${text.slice(0, 400)}`));
          try {
            resolve(parseAnswer(text, shape));
          } catch (e) {
            reject(e);
          }
        });
        child.stdin.end(prompt);
      }),
  };
}

/** A model that answers from a fixed list, in order: tests and dry runs. */
export function scriptedModel(answers: unknown[], id = "scripted"): Model {
  let i = 0;
  return {
    id,
    ask: async (_prompt, shape) => {
      const a = answers[i++];
      if (a === undefined) throw new Error(`scripted model has no answer ${i}`);
      return shape.parse(a);
    },
  };
}
