/**
 * The engine from a shell: `run` an ask, `trace` a run, `keep` or `drop` a finding by hand, `steer`
 * a run, say a `gap`, send it `back` to a step,
 * `yield` per source, `sources` on this machine. Every command prints JSON, so Claude Code
 * can drive it. The ledger is a folder (`--ledger`, WEAVER_LEDGER, default `./ledger`); a
 * writer names this terminal's file in it (`--writer`, WEAVER_WRITER, default the user name).
 * The model is a `@wrenautomation/models` spec: `anthropic` by default (Claude Haiku direct,
 * ANTHROPIC_API_KEY), `gateway[:alias]`, `gemini`, `claude-code`, `command:<cmd>` and the rest
 * of its grammar. A host with its own ledger, sources or
 * model passes them in `EngineCliDeps`; wren's `research` command is these commands over
 * Postgres. A run that stops on a transient failure (a 429, a 5xx, a dropped connection) is
 * resumed by `run` itself after a pause, up to RESUMES times.
 */
import { userInfo } from "node:os";
import type { Extractor } from "@wrenautomation/falcon/document";
import { claimExtractor } from "@wrenautomation/falcon/document";
import { geminiVideo } from "@wrenautomation/falcon/video";
import { isTransient, type Model } from "@wrenautomation/models";
import { modelFromSpec } from "@wrenautomation/models/spec";
import {
  type AskKind,
  defaultPlanFile,
  PLAN_KINDS,
  type PlanFile,
  type Proposal,
  Step as RavenStep,
} from "@wrenautomation/raven";
import type { Command } from "commander";
import { fold, registry, run, type Source, type Sources, type StepEvent } from "../engine/index.js";
import { PoliteFetcher, userAgent } from "../fetch/fetcher.js";
import {
  FilesLedger,
  type Ledger,
  type LedgerRecord,
  ofType,
  type Problem,
  type SpendRecord,
  ulids,
} from "../ledger/index.js";
import {
  exa,
  fetcherSource,
  httpLadderClient,
  ladderSource,
  ledgerSource,
  paste,
  searxng,
  ytdlpSource,
} from "../sources/index.js";

const DEFAULT_MODEL = "anthropic";
/** Resumes `run` makes on its own after a transient failure. */
export const RESUMES = 5;
/** The longest pause before a resume, whatever `retry-after` said. */
const MAX_RESUME_WAIT_MS = 300_000;

/** The pause before a resume: to `retryAfter` (five minutes at most), else 15 s per resume so far. */
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

export function resumeWaitMs(n: number, retryAfter: string | undefined, now = Date.now()): number {
  if (retryAfter) {
    const until = Date.parse(retryAfter) - now;
    if (!Number.isNaN(until)) return Math.max(0, Math.min(until, MAX_RESUME_WAIT_MS));
  }
  return 15_000 * n;
}

/** `NAME`, then `NAME_1`, `NAME_2`, ... in order: a fleet of keys for one vendor. */
export function keys(printed: NodeJS.ProcessEnv, name: string): string[] {
  const out: string[] = [];
  const one = printed[name];
  if (one) out.push(one);
  for (let i = 1; ; i++) {
    const k = printed[`${name}_${i}`];
    if (!k) break;
    out.push(k);
  }
  return out;
}

export interface Common {
  ledger: string;
  writer: string;
}

/** A ledger a host hands the commands: the contract, and what the files backend adds when it has it. */
export type HostLedger = Ledger & {
  readPlan?(kind: AskKind): Promise<PlanFile | null>;
  problems?: Problem[];
};

/** What a host swaps in: the files backend, this machine's sources and `--model` are the defaults. */
export interface EngineCliDeps {
  ledger?(o: Common): HostLedger;
  sources?(o: Common, ledger: HostLedger): Sources;
  /** The model for a `--model` spec; the default is models' `modelFromSpec`. */
  model?(spec: string, printed: NodeJS.ProcessEnv): Model;
  extractor?: Extractor;
  /** The pause before a resume; a test passes a stub. */
  sleep?(ms: number): Promise<void>;
}

const filesLedger = (o: Common) => new FilesLedger(o.ledger, o.writer);

/** The sources this machine can run, from the environment. */
export function sourcesHere(
  printed: NodeJS.ProcessEnv,
  ledger: FilesLedger,
  ytDlp: string,
  warn: (line: string) => void = (l) => console.error(l),
): Sources {
  const out: Source[] = [];
  if (printed.SEARXNG_URL)
    out.push(
      searxng({
        url: printed.SEARXNG_URL,
        ...(printed.SEARXNG_TOKEN ? { token: printed.SEARXNG_TOKEN } : {}),
      }),
    );
  const exaKeys = keys(printed, "EXA_API_KEY");
  if (exaKeys.length) out.push(exa({ keys: exaKeys }));
  const geminiKeys = keys(printed, "GEMINI_API_KEY");
  out.push(
    ytdlpSource({
      ytDlp,
      ...(geminiKeys.length ? { video: () => geminiVideo(geminiKeys) } : {}),
    }),
  );
  if (printed.WEAVER_CONTACT)
    out.push(fetcherSource({ fetcher: new PoliteFetcher(userAgent(printed.WEAVER_CONTACT)) }));
  else warn("no WEAVER_CONTACT (an email address or URL for site operators): pages stay unopened");
  if (printed.AUTOBROWSE_URL)
    out.push(
      ladderSource({
        sites: httpLadderClient({
          url: printed.AUTOBROWSE_URL,
          token: printed.AUTOBROWSE_TOKEN ?? null,
        }),
      }),
    );
  out.push(ledgerSource(ledger));
  return registry(...out);
}

/**
 * The run's allow-list: the names wanted that exist here, then (unless the list was given by
 * hand) every opener here. A name wanted that this machine lacks is dropped with a line on stderr.
 */
export function allowList(
  sources: Sources,
  wanted: readonly string[],
  byHand: boolean,
  warn: (line: string) => void = (l) => console.error(l),
): string[] {
  const out: string[] = [];
  for (const name of wanted) {
    if (sources.has(name)) out.push(name);
    else warn(`no source named ${name} here: skipped`);
  }
  if (!byHand)
    for (const s of sources.values()) if (s.open && !out.includes(s.name)) out.push(s.name);
  return out;
}

const progress = (e: StepEvent) =>
  console.error(
    `${e.run} ${e.round}.${e.step} ${e.ok ? "ok" : "gave up"} ${e.ms}ms${e.note ? `: ${e.note}` : ""}`,
  );

export function addEngineCommands(program: Command, deps: EngineCliDeps = {}): void {
  const ledgerOf = deps.ledger ?? filesLedger;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const common = (c: Command) =>
    c
      .option("--ledger <dir>", "the ledger folder", process.env.WEAVER_LEDGER ?? "./ledger")
      .option(
        "--writer <name>",
        "this terminal's file in the ledger",
        process.env.WEAVER_WRITER ?? userInfo().username,
      );

  common(program.command("run [ask]"))
    .description(
      "run an ask through plan, fetch, triage, read, extract, check and review; prints the run as JSON",
    )
    .option("--kind <kind>", `one of ${PLAN_KINDS.join(", ")}`, "web")
    .option("--known <line...>", "what is known already, one line each")
    .option("--steer <line...>", "what you say to the model, first in every prompt")
    .option("--site <host>", "the site the ask is about")
    .option(
      "--sources <name...>",
      "the allow-list for this run (default: the plan file's, as far as this machine has them)",
    )
    .option("--propose <terms...>", "queries from you, merged with the model's in round 1")
    .option("--url <url...>", "pages you want read: a paste source, first in the allow-list")
    .option(
      "--by <who>",
      "who proposes or pastes",
      process.env.WEAVER_WRITER ?? userInfo().username,
    )
    .option(
      "--model <spec>",
      "a models spec: anthropic[:haiku|sonnet|opus], gateway[:alias], gemini[:id], claude-code, command:<cmd>, ...",
      process.env.WEAVER_MODEL ?? DEFAULT_MODEL,
    )
    .option("--no-model", "no model: your queries only, every hit read, nothing extracted")
    .option("--resume <run>", "continue an earlier run from the step it stopped on")
    .option("--run <id>", "the new run's id")
    .option("--pause", "stop after each round's review: `weaver steer`, then --resume")
    .option("--yt-dlp <cmd>", "the yt-dlp command", process.env.WEAVER_YTDLP ?? "yt-dlp")
    .action(
      async (
        ask: string | undefined,
        o: Common & {
          kind: string;
          known?: string[];
          steer?: string[];
          site?: string;
          sources?: string[];
          propose?: string[];
          url?: string[];
          by: string;
          model: string | false;
          resume?: string;
          run?: string;
          pause?: boolean;
          ytDlp: string;
        },
      ) => {
        if (!ask && !o.resume) throw new Error("run needs an ask, or --resume <run>");
        const kind = defaultPlanFile(o.kind as never).kind;
        const ledger = ledgerOf(o);
        const sources = deps.sources
          ? deps.sources(o, ledger)
          : sourcesHere(process.env, ledger as FilesLedger, o.ytDlp);
        if (o.url?.length)
          sources.set(
            "paste",
            paste(
              o.url.map((url) => ({ url })),
              o.by,
            ),
          );
        const stock = defaultPlanFile(kind);
        const tuned = (await ledger.readPlan?.(kind)) ?? stock;
        if (tuned.version < stock.version)
          console.error(
            `plan file ${kind} is version ${tuned.version}; weaver ships ${stock.version}: delete it to take the new one`,
          );
        const wanted = o.sources ?? [...(o.url?.length ? ["paste"] : []), ...tuned.sources];
        // raven narrows to the plan file's sources, so the run's allow-list goes in as the plan file's.
        const planFile = { ...tuned, sources: allowList(sources, wanted, !!o.sources) };
        const model: Model | null =
          o.model === false ? null : (deps.model ?? modelFromSpec)(o.model, process.env);
        const byHand = [
          ...(o.propose ?? []).map((terms) => ({ kind, terms, why: "proposed by hand" })),
          // The paste answers the first query it sees: this one, when nothing else is proposed.
          ...(o.url?.length && !o.propose?.length && ask
            ? [{ kind, terms: ask, why: "the pasted pages" }]
            : []),
        ];
        const proposals: Proposal[] = byHand.length
          ? [{ from: "human", by: o.by, queries: byHand }]
          : [];
        const id = o.resume ?? o.run ?? ulids()();
        const engineDeps = {
          sources,
          ledger,
          model,
          extractor: deps.extractor ?? claimExtractor,
          clock: () => new Date(),
          ids: ulids(),
          runner: o.writer,
        };
        const options = {
          ...(ask
            ? {
                ask: {
                  text: ask,
                  kind,
                  known: o.known ?? [],
                  steer: o.steer ?? [],
                  ...(o.site ? { site: o.site } : {}),
                },
              }
            : {}),
          planFile,
          proposals,
          onStep: progress,
          ...(o.pause ? { pause: true } : {}),
        };
        let result: Awaited<ReturnType<typeof run>> | null = null;
        for (let n = 0; result === null; n++) {
          try {
            result = await run(engineDeps, {
              ...options,
              ...(n === 0 && !o.resume ? { run: id } : { resume: id }),
            });
          } catch (err) {
            if (!isTransient(err)) throw err;
            if (n >= RESUMES) {
              console.error(`${id}: ${err.message}; stopped after ${RESUMES} resumes`);
              break;
            }
            const ms = resumeWaitMs(n + 1, err.retryAfter);
            console.error(
              `${id}: ${err.message}; resume ${n + 1} of ${RESUMES} in ${Math.round(ms / 1000)}s`,
            );
            await sleep(ms);
          }
        }
        const state = result?.state ?? fold(id, await ledger.trace(id));
        if (result?.paused)
          console.error(
            `${id}: paused after round ${state.edges.length}; weaver steer ${id} "<what you say>", then weaver run --resume ${id} --pause`,
          );
        const cost = costOf(state.spends);
        console.error(`${id}: ${cost.line}`);
        console.log(
          JSON.stringify(
            {
              run: id,
              rounds: state.round,
              cost: cost.total,
              finished: result?.finished ?? false,
              ...(result?.paused ? { paused: true } : {}),
              note: result ? result.note : "stopped on a transient failure: --resume to go on",
              hits: state.hits.length,
              documents: state.documents.length,
              findings: state.findings.filter((f) => state.called.get(f.id) !== "drop"),
              spends: state.spends.map(({ source, op, about, ok, cost, ms, usd, tokens }) => ({
                source,
                op,
                about,
                ok,
                cost,
                ms,
                ...(usd !== undefined ? { usd } : {}),
                ...(tokens ? { tokens } : {}),
              })),
              problems: ledger.problems ?? [],
            },
            null,
            2,
          ),
        );
        if (!result?.finished && !result?.paused) process.exitCode = 2;
      },
    );

  common(program.command("trace <run>"))
    .description("every record of a run, in time order, as JSON lines")
    .option("--type <type...>", "only these record types")
    .action(async (id: string, o: Common & { type?: string[] }) => {
      const ledger = ledgerOf(o);
      const records = await ledger.trace(id);
      if (!records.length) throw new Error(`run ${id}: no records`);
      for (const r of records)
        if (!o.type || o.type.includes(r.type)) console.log(JSON.stringify(r));
      for (const p of ledger.problems ?? []) console.error(`${p.file}:${p.line}: ${p.why}`);
    });

  for (const verdict of ["keep", "drop"] as const)
    common(program.command(`${verdict} <finding>`))
      .description(`${verdict} a finding by hand: a call record in your name`)
      .requiredOption("-r, --reason <why>", "why")
      .action(async (findingId: string, o: Common & { reason: string }) => {
        const ledger = ledgerOf(o);
        const finding = ofType(await ledger.scan({ type: "finding" }), "finding").find(
          (f) => f.id === findingId,
        );
        if (!finding) throw new Error(`no finding ${findingId}`);
        const record: LedgerRecord = {
          type: "call",
          id: ulids()(),
          run: finding.run,
          round: finding.round,
          at: new Date().toISOString(),
          from: "human",
          by: o.writer,
          on: finding.id,
          verdict,
          why: o.reason,
        };
        await ledger.append(record);
        console.log(JSON.stringify(record));
      });

  common(program.command("steer <run> <text>"))
    .description("say something to the run: first in every prompt of the rounds after it")
    .action(async (runId: string, text: string, o: Common) => {
      const ledger = ledgerOf(o);
      const state = fold(runId, await ledger.trace(runId));
      if (!state.records.length) throw new Error(`no run ${runId}`);
      const record: LedgerRecord = {
        type: "steer",
        id: ulids()(),
        run: runId,
        round: state.round,
        at: new Date().toISOString(),
        from: "human",
        by: o.writer,
        text,
      };
      await ledger.append(record);
      console.log(JSON.stringify(record));
    });

  common(program.command("gap <run> <text>"))
    .description("say what the run still lacks: the round's review and the next plan read it")
    .action(async (runId: string, text: string, o: Common) => {
      const ledger = ledgerOf(o);
      const state = fold(runId, await ledger.trace(runId));
      if (!state.records.length) throw new Error(`no run ${runId}`);
      const record: LedgerRecord = {
        type: "gap",
        id: ulids()(),
        run: runId,
        round: state.round,
        at: new Date().toISOString(),
        from: "human",
        by: o.writer,
        note: text,
      };
      await ledger.append(record);
      console.log(JSON.stringify(record));
    });

  common(program.command("back <run> <step>"))
    .description(
      "send the run back to one step of its round (plan, fetch, triage, read, extract); `run --resume` goes on from there",
    )
    .requiredOption("-r, --reason <why>", "why")
    .action(async (runId: string, step: string, o: Common & { reason: string }) => {
      const to = RavenStep.parse(step);
      const ledger = ledgerOf(o);
      const state = fold(runId, await ledger.trace(runId));
      if (!state.records.length) throw new Error(`no run ${runId}`);
      const record: LedgerRecord = {
        type: "edge",
        id: ulids()(),
        run: runId,
        round: state.round,
        at: new Date().toISOString(),
        from: "human",
        by: o.writer,
        next: "back",
        to,
        why: o.reason,
      };
      await ledger.append(record);
      console.log(JSON.stringify(record));
    });

  common(program.command("yield"))
    .description("hits, reads, proposed and kept per source, by, channel and kind, over every run")
    .option("--source <name>")
    .option("--by <who>")
    .option("--channel <name>")
    .option("--kind <kind>")
    .action(
      async (o: Common & { source?: string; by?: string; channel?: string; kind?: string }) => {
        const rows = await ledgerOf(o).yield({
          ...(o.source ? { source: o.source } : {}),
          ...(o.by ? { by: o.by } : {}),
          ...(o.channel ? { channel: o.channel } : {}),
          ...(o.kind ? { kind: defaultPlanFile(o.kind as never).kind } : {}),
        });
        console.log(JSON.stringify(rows, null, 2));
      },
    );

  common(program.command("sources"))
    .description("the sources this machine can run, from the environment")
    .option("--yt-dlp <cmd>", "the yt-dlp command", process.env.WEAVER_YTDLP ?? "yt-dlp")
    .action(async (o: Common & { ytDlp: string }) => {
      const ledger = ledgerOf(o);
      const sources = deps.sources
        ? deps.sources(o, ledger)
        : sourcesHere(process.env, ledger as FilesLedger, o.ytDlp);
      const rows = [...sources.values()].map(({ name, kind, cost, from }) => ({
        name,
        kind,
        cost,
        from: from ?? "tool",
      }));
      console.log(JSON.stringify(rows, null, 2));
    });
}
