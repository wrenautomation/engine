/**
 * The engine from a shell: `run` an ask, `trace` a run, `keep` or `drop` a finding by hand,
 * `yield` per source, `sources` on this machine. Every command prints JSON, so Claude Code
 * can drive it. The ledger is a folder (`--ledger`, WEAVER_LEDGER, default `./ledger`); a
 * writer names this terminal's file in it (`--writer`, WEAVER_WRITER, default the user name).
 * The model is `claude -p --output-format json` by default (Claude Code headless, raven's way:
 * any command that reads a prompt on stdin and prints the answer), or `gateway[:alias]` for
 * Wren's LLM gateway (WREN_LLM_GATEWAY_URL and WREN_LLM_GATEWAY_TOKEN).
 */
import { userInfo } from "node:os";
import { claimExtractor } from "@wrenautomation/falcon/document";
import {
  commandModel,
  defaultPlanFile,
  type Model,
  PLAN_KINDS,
  type Proposal,
} from "@wrenautomation/raven";
import type { Command } from "commander";
import { registry, run, type Source, type Sources, type StepEvent } from "../engine/index.js";
import { PoliteFetcher, userAgent } from "../fetch/fetcher.js";
import { FilesLedger, type LedgerRecord, ofType, ulids } from "../ledger/index.js";
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
import { gatewayModel } from "./gateway-model.js";

const DEFAULT_MODEL = "claude -p --output-format json";

/** `gateway[:alias]` is the LLM gateway; anything else is a command, raven's way. */
export function modelOf(spec: string, printed: NodeJS.ProcessEnv): Model {
  const m = /^gateway(?::(.+))?$/.exec(spec);
  if (!m) return commandModel(spec, spec === DEFAULT_MODEL ? "claude-code" : spec);
  if (!printed.WREN_LLM_GATEWAY_URL) throw new Error("--model gateway needs WREN_LLM_GATEWAY_URL");
  return gatewayModel({
    url: printed.WREN_LLM_GATEWAY_URL,
    token: printed.WREN_LLM_GATEWAY_TOKEN ?? null,
    ...(m[1] ? { model: m[1] } : {}),
  });
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

interface Common {
  ledger: string;
  writer: string;
}

const ledgerOf = (o: Common) => new FilesLedger(o.ledger, o.writer);

/** The sources this machine can run, from the environment. */
export function sourcesHere(
  printed: NodeJS.ProcessEnv,
  ledger: FilesLedger,
  ytDlp: string,
  warn: (line: string) => void = (l) => console.error(l),
): Sources {
  const out: Source[] = [];
  if (printed.SEARXNG_URL) out.push(searxng({ url: printed.SEARXNG_URL }));
  const exaKeys = keys(printed, "EXA_API_KEY");
  if (exaKeys.length) out.push(exa({ keys: exaKeys }));
  out.push(ytdlpSource({ ytDlp, geminiKeys: keys(printed, "GEMINI_API_KEY") }));
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

export function addEngineCommands(program: Command): void {
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
      "run an ask through plan, fetch, triage, read, extract and review; prints the run as JSON",
    )
    .option("--kind <kind>", `one of ${PLAN_KINDS.join(", ")}`, "web")
    .option("--known <line...>", "what is known already, one line each")
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
      "--model <command>",
      "gateway[:alias], or a command (stdin: prompt, stdout: answer)",
      process.env.WEAVER_MODEL ?? DEFAULT_MODEL,
    )
    .option("--no-model", "no model: your queries only, every hit read, nothing extracted")
    .option("--resume <run>", "continue an earlier run from the step it stopped on")
    .option("--run <id>", "the new run's id")
    .option("--yt-dlp <cmd>", "the yt-dlp command", process.env.WEAVER_YTDLP ?? "yt-dlp")
    .action(
      async (
        ask: string | undefined,
        o: Common & {
          kind: string;
          known?: string[];
          site?: string;
          sources?: string[];
          propose?: string[];
          url?: string[];
          by: string;
          model: string | false;
          resume?: string;
          run?: string;
          ytDlp: string;
        },
      ) => {
        if (!ask && !o.resume) throw new Error("run needs an ask, or --resume <run>");
        const kind = defaultPlanFile(o.kind as never).kind;
        const ledger = ledgerOf(o);
        const sources = sourcesHere(process.env, ledger, o.ytDlp);
        if (o.url?.length)
          sources.set(
            "paste",
            paste(
              o.url.map((url) => ({ url })),
              o.by,
            ),
          );
        const tuned = (await ledger.readPlan(kind)) ?? defaultPlanFile(kind);
        const wanted = o.sources ?? [...(o.url?.length ? ["paste"] : []), ...tuned.sources];
        // raven narrows to the plan file's sources, so the run's allow-list goes in as the plan file's.
        const planFile = { ...tuned, sources: allowList(sources, wanted, !!o.sources) };
        const model: Model | null = o.model === false ? null : modelOf(o.model, process.env);
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
        const result = await run(
          {
            sources,
            ledger,
            model,
            extractor: claimExtractor,
            clock: () => new Date(),
            ids: ulids(),
            runner: o.writer,
          },
          {
            ...(ask
              ? {
                  ask: {
                    text: ask,
                    kind,
                    known: o.known ?? [],
                    ...(o.site ? { site: o.site } : {}),
                  },
                }
              : {}),
            planFile,
            proposals,
            ...(o.resume ? { resume: o.resume } : {}),
            ...(o.run ? { run: o.run } : {}),
            onStep: progress,
          },
        );
        const { state } = result;
        console.log(
          JSON.stringify(
            {
              run: result.run,
              rounds: result.rounds,
              finished: result.finished,
              note: result.note,
              hits: state.hits.length,
              documents: state.documents.length,
              findings: state.findings.filter((f) => state.verdicts.get(f.id) !== "drop"),
              spends: state.spends.map(({ source, op, about, ok, cost, ms, usd }) => ({
                source,
                op,
                about,
                ok,
                cost,
                ms,
                ...(usd !== undefined ? { usd } : {}),
              })),
              problems: ledger.problems,
            },
            null,
            2,
          ),
        );
        if (!result.finished) process.exitCode = 2;
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
      for (const p of ledger.problems) console.error(`${p.file}:${p.line}: ${p.why}`);
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
      const rows = [...sourcesHere(process.env, ledgerOf(o), o.ytDlp).values()].map(
        ({ name, kind, cost, from }) => ({
          name,
          kind,
          cost,
          from: from ?? "tool",
        }),
      );
      console.log(JSON.stringify(rows, null, 2));
    });
}
