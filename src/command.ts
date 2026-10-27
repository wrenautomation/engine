/**
 * A model that is a local process (Node only, its own door): any shell command with the prompt on
 * stdin and the answer on stdout, or Claude Code headless on the person's own subscription.
 */
import { execFile, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { Transient } from "./errors.js";
import { modelOf, promptText, TEXT_ONLY } from "./model.js";
import type { Model, Reply, Request, Usage } from "./types.js";

/** What `claude -p --output-format json` prints; only what is read. */
interface Envelope {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

const isEnvelope = (v: unknown): v is Envelope & { result: string } =>
  typeof v === "object" && v !== null && typeof (v as Envelope).result === "string";

/** The answer and usage from a command's stdout: Claude Code's envelope, else the whole text. */
export function readOutput(stdout: string): { text: string; usage?: Usage; envelope?: Envelope } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { text: stdout };
  }
  if (!isEnvelope(parsed)) return { text: stdout };
  const u = parsed.usage;
  const usage: Usage = {};
  const read = u?.cache_read_input_tokens ?? 0;
  const write = u?.cache_creation_input_tokens ?? 0;
  if (u?.input_tokens !== undefined) usage.input = u.input_tokens + read + write;
  if (u?.output_tokens !== undefined) usage.output = u.output_tokens;
  if (read) usage.cacheRead = read;
  if (write) usage.cacheWrite = write;
  if (parsed.total_cost_usd !== undefined) usage.usd = parsed.total_cost_usd;
  return { text: parsed.result, usage, envelope: parsed };
}

const textOf = (id: string, req: Request): string => {
  const text = promptText(req.prompt);
  if (text === null) throw new Error(`${id} takes text only`);
  return req.system ? `${req.system}\n\n${text}` : text;
};

const reply = (id: string, stdout: string, ms: number, free: boolean): Reply => {
  const { text, usage = {}, envelope } = readOutput(stdout);
  if (envelope?.is_error || !text.trim())
    throw new Error(`${id}: ${envelope?.subtype ?? "empty answer"}: ${text.slice(0, 300)}`);
  const cost: Usage =
    free && usage.usd !== undefined ? { ...usage, usd: 0, free: true, listUsd: usage.usd } : usage;
  return {
    text,
    usage: cost,
    model: id,
    stop: envelope?.subtype,
    ms,
    raw: envelope ? { ...envelope, result: undefined } : {},
  };
};

/**
 * Any shell command as a model. A command that says nothing for `timeoutMs` (3 minutes) is
 * killed and the call throws `Transient`, so a hung model never hangs the run.
 */
export function commandModel(command: string, o: { id?: string; timeoutMs?: number } = {}): Model {
  const id = o.id ?? command;
  const timeoutMs = o.timeoutMs ?? 180_000;
  return modelOf({
    id,
    provider: "command",
    takes: TEXT_ONLY,
    complete: (req) =>
      new Promise((resolve, reject) => {
        const started = performance.now();
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
            return reject(new Transient(`${id}: no answer in ${Math.round(timeoutMs / 1000)}s`));
          if (code !== 0) return reject(new Error(`${id} exited ${code}: ${stdout.slice(0, 400)}`));
          try {
            resolve(reply(id, stdout, Math.round(performance.now() - started), false));
          } catch (e) {
            reject(e);
          }
        });
        child.stdin.end(textOf(id, req));
      }),
  });
}

export type ClaudeRun = (args: string[], stdin: string, timeoutMs: number) => Promise<string>;

/** The subscription pays: an `ANTHROPIC_API_KEY` would take over from the login, so the child never sees one. */
export function claudeChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { ANTHROPIC_API_KEY: _drop, ...rest } = env;
  return rest;
}

function spawnClaude(bin: string): ClaudeRun {
  return (args, stdin, timeoutMs) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        bin,
        args,
        { cwd: tmpdir(), timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: claudeChildEnv() },
        (err, stdout, stderr) => {
          // A failed call still prints its JSON (is_error, why) on stdout: the reader says it.
          if (!err || (!err.killed && stdout.trim().startsWith("{"))) return resolve(stdout);
          if (err.killed) return reject(new Transient(`claude -p: killed after ${timeoutMs}ms`));
          reject(
            new Error(`claude -p exit ${err.code ?? "?"}: ${(stderr || stdout).slice(0, 400)}`),
          );
        },
      );
      child.stdin?.end(stdin);
    });
}

/** Kept short: the prompt carries the task and the output shape. */
const SYSTEM = "Do exactly what the message asks. Reply with only the answer, no preamble.";

/**
 * Claude Code headless (`claude -p`), one process per call, on the person's subscription: its
 * cost is 0 and its list price kept. Tools, MCP servers, skills and settings are off, and it runs
 * in a scratch folder, so nothing on disk is touched. About 2 s to start: right for a few big
 * calls, wrong for thousands of rows. `maxTokens` has no flag here; the prompt bounds the answer.
 */
export function claudeCode(
  model = "sonnet",
  o: { bin?: string; timeoutMs?: number; run?: ClaudeRun } = {},
): Model {
  const id = `claude-code:${model}`;
  const run = o.run ?? spawnClaude(o.bin ?? "claude");
  const timeoutMs = o.timeoutMs ?? 300_000;
  return modelOf({
    id,
    provider: "claude-code",
    takes: TEXT_ONLY,
    async complete(req) {
      const text = promptText(req.prompt);
      if (text === null) throw new Error(`${id} takes text only`);
      const args = [
        "-p",
        ...["--output-format", "json", "--model", model],
        ...["--system-prompt", req.system ?? SYSTEM],
        ...["--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'],
        ...["--disable-slash-commands", "--setting-sources", "", "--no-session-persistence"],
      ];
      const started = performance.now();
      const out = await run(args, text, timeoutMs);
      return reply(id, out, Math.round(performance.now() - started), true);
    },
  });
}
