/**
 * The model seam. Raven never picks a model: a caller hands in one `Model`, a function from a
 * prompt and an answer shape to a parsed answer with what it cost, and its id goes on every
 * record it writes. In a terminal the model is a command that reads the prompt on stdin and
 * prints the answer (`claude -p --output-format json` by default); in wren it wraps the LLM
 * client.
 */
import { spawn } from "node:child_process";
import type { ZodType } from "zod";

/** What one model call cost, as far as the model says. All optional: a shell command may say nothing. */
export interface Usage {
  /** Tokens in and out. */
  input?: number;
  output?: number;
  usd?: number;
}

/** A parsed answer and what it cost: the ledger keeps both. */
export interface Answer<T> {
  value: T;
  usage?: Usage;
}

export interface Model {
  /** What goes in `by` on the records this model writes. */
  id: string;
  ask<T>(prompt: string, shape: ZodType<T>): Promise<Answer<T>>;
}

/** `{name}` marks filled in one pass; a `{word}` with no value stays as text. */
export const fill = (template: string, values: Readonly<Record<string, string>>): string =>
  template.replace(/\{(\w+)\}/g, (mark, name: string) => values[name] ?? mark);

/** Every balanced `{...}` in a text, by start position: an outer object comes before its inner ones. */
function* objects(text: string): Generator<string> {
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        yield text.slice(start, i + 1);
        break;
      }
    }
  }
}

/**
 * The first JSON object of the shape in a model's text, found by brace balance: fences, prose
 * and stray braces around it are passed over. Throws with the model's text when nothing parses.
 */
export function parseAnswer<T>(text: string, shape: ZodType<T>): T {
  for (const candidate of objects(text)) {
    try {
      const out = shape.safeParse(JSON.parse(candidate));
      if (out.success) return out.data;
    } catch {}
  }
  throw new Error(`no answer of the expected shape in: ${text.slice(0, 400)}`);
}

/** What `claude -p --output-format json` prints: the answer text and what it cost. */
interface ResultEnvelope {
  result: string;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
}

const isEnvelope = (x: unknown): x is ResultEnvelope =>
  typeof x === "object" && x !== null && typeof (x as { result?: unknown }).result === "string";

/** A command's stdout as an answer: the envelope's text and usage when it printed one, else the text. */
export function readOutput(stdout: string): { text: string; usage?: Usage } {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (isEnvelope(parsed)) {
      const usage: Usage = {};
      if (parsed.usage?.input_tokens !== undefined) usage.input = parsed.usage.input_tokens;
      if (parsed.usage?.output_tokens !== undefined) usage.output = parsed.usage.output_tokens;
      if (parsed.total_cost_usd !== undefined) usage.usd = parsed.total_cost_usd;
      return { text: parsed.result, usage };
    }
  } catch {}
  return { text: stdout };
}

/**
 * A model that is a shell command: the prompt on stdin, the answer on stdout. When stdout is
 * Claude Code's JSON envelope (`claude -p --output-format json`) the usage comes with it.
 * A command that says nothing for `timeoutMs` (3 minutes) is killed and the ask fails with
 * why, so a hung model never hangs the run.
 */
export function commandModel(command: string, id = command, timeoutMs = 180_000): Model {
  return {
    id,
    ask: (prompt, shape) =>
      new Promise((resolve, reject) => {
        const child = spawn(command, { shell: true, stdio: ["pipe", "pipe", "inherit"] });
        const out: Buffer[] = [];
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill();
        }, timeoutMs);
        child.stdout.on("data", (b: Buffer) => out.push(b));
        child.on("error", (e) => {
          clearTimeout(timer);
          reject(e);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          const stdout = Buffer.concat(out).toString("utf8");
          if (timedOut)
            return reject(new Error(`${command}: no answer in ${Math.round(timeoutMs / 1000)}s`));
          if (code !== 0)
            return reject(new Error(`${command} exited ${code}: ${stdout.slice(0, 400)}`));
          try {
            const { text, usage } = readOutput(stdout);
            resolve({ value: parseAnswer(text, shape), ...(usage ? { usage } : {}) });
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
      return { value: shape.parse(a) };
    },
  };
}
