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
import { readFile } from "node:fs/promises";
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
  QueryTree,
  Step as RavenStep,
  TreeGuide,
  treeOf,
} from "@wrenautomation/raven";
import type { Command } from "commander";
import {
  type Addition,
  add,
  brief,
  check,
  costOf,
  type Did,
  type DraftInput,
  extract,
  fold,
  joined,
  open,
  planRound,
  type QueryInput,
  recall,
  registry,
  run,
  type Source,
  type Sources,
  type StepEvent,
  search,
  searchTree,
  tunePlan,
  type Who,
} from "../engine/index.js";
import { PoliteFetcher, userAgent } from "../fetch/fetcher.js";
import type { LadderClient } from "../fetch/ladder.js";
import { FilesLedger, type Ledger, type Problem, ulids } from "../ledger/index.js";
import {
  accountsFrom,
  exa,
  facebookSource,
  fetcherSource,
  httpLadderClient,
  ingressLadderClient,
  ladderSource,
  ledgerSource,
  paste,
  redditSource,
  searxng,
  ytdlpSource,
} from "../sources/index.js";

const DEFAULT_MODEL = "anthropic";
/** Resumes `run` makes on its own after a transient failure. */
export const RESUMES = 5;
/** The longest pause before a resume, whatever `retry-after` said. */
const MAX_RESUME_WAIT_MS = 300_000;

export { costOf };

/** The pause before a resume: to `retryAfter` (five minutes at most), else 15 s per resume so far. */
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
export type HostLedger = Ledger & { problems?: Problem[] };

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
  const sites: LadderClient | null = printed.AUTOBROWSE_URL
    ? httpLadderClient({ url: printed.AUTOBROWSE_URL, token: printed.AUTOBROWSE_TOKEN ?? null })
    : printed.RESTATE_INGRESS_URL
      ? ingressLadderClient({
          url: printed.RESTATE_INGRESS_URL,
          token: printed.RESTATE_AUTH_TOKEN ?? null,
          ...(printed.AUTOBROWSE_SERVICE ? { service: printed.AUTOBROWSE_SERVICE } : {}),
          caller: `weaver:${printed.WEAVER_AGENT ?? "runner"}`,
        })
      : null;
  if (sites) {
    // The account each site reader signs in as: the caller's choice, never a default here.
    const accounts = accountsFrom(printed.WEAVER_ACCOUNTS);
    const reddit = accounts.get("reddit");
    out.push(
      ladderSource({ sites }),
      redditSource({ sites, ...(reddit ? { account: reddit } : {}) }),
      facebookSource({ sites }),
    );
  }
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

/** The options a command that runs sources or a model takes. */
interface Machine {
  model: string | false;
  ytDlp: string;
}

/** The options an agent's command takes: who writes, in whose name. */
interface Agent {
  by?: string;
  human?: string | true;
}

/** A kind the engine plans for; anything else is the caller's mistake, said in words. */
export const kindOf = (kind: string): AskKind => {
  const k = PLAN_KINDS.find((p) => p === kind);
  if (!k) throw new Error(`no kind "${kind}": the kinds are ${PLAN_KINDS.join(", ")}`);
  return k;
};

/** Prints what a command did as JSON; a step that gave up exits 2, like `run`. */
function printDid(did: Did): void {
  console.error(
    `${did.run} ${did.round}.${did.step} ${did.ok ? "ok" : "gave up"}${did.note ? `: ${did.note}` : ""}`,
  );
  console.log(JSON.stringify(did, null, 2));
  if (!did.ok) process.exitCode = 2;
}

/** Whole stdin, for a batch of queries as JSON. */
async function stdinText(): Promise<string> {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

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
  const machine = (c: Command) =>
    c
      .option(
        "--model <spec>",
        "a models spec: anthropic[:haiku|sonnet|opus], gateway[:alias], gemini[:id], claude-code, command:<cmd>, ...",
        process.env.WEAVER_MODEL ?? DEFAULT_MODEL,
      )
      .option("--no-model", "no model: nothing extracted or checked")
      .option("--yt-dlp <cmd>", "the yt-dlp command", process.env.WEAVER_YTDLP ?? "yt-dlp");
  const agent = (c: Command) =>
    c
      .option("--by <agent>", "the agent's id on what it writes", process.env.WEAVER_AGENT)
      .option(
        "--human [name]",
        "the record is the person's word, relayed: from human, by their name (default: the writer)",
      );
  /** The ledger, this machine's sources and the model, from the options. */
  const setup = (o: Common & Machine) => {
    const ledger = ledgerOf(o);
    const sources = deps.sources
      ? deps.sources(o, ledger)
      : sourcesHere(process.env, ledger as FilesLedger, o.ytDlp);
    const model: Model | null =
      o.model === false ? null : (deps.model ?? modelFromSpec)(o.model, process.env);
    return { ledger, sources, model };
  };
  /**
   * The ledger's tuned plan file for the kind (the stock one when none), its sources the run's
   * allow-list: the names given by hand, else `first` then the plan file's, as far as this
   * machine has them.
   */
  const planFileOf = async (
    ledger: HostLedger,
    sources: Sources,
    kind: AskKind,
    byHand: string[] | undefined,
    first: string[] = [],
  ): Promise<PlanFile> => {
    const stock = defaultPlanFile(kind);
    const tuned = (await ledger.readPlan?.(kind)) ?? stock;
    if (tuned.version < stock.version)
      console.error(
        `plan file ${kind} is version ${tuned.version}; weaver ships ${stock.version}: delete it to take the new one`,
      );
    const wanted = byHand ?? [...first, ...tuned.sources];
    // raven narrows to the plan file's sources, so the run's allow-list goes in as the plan file's.
    return { ...tuned, sources: allowList(sources, wanted, !!byHand) };
  };
  const depsOf = (s: ReturnType<typeof setup>, runner: string) => ({
    ...s,
    extractor: deps.extractor ?? claimExtractor,
    clock: () => new Date(),
    ids: ulids(),
    runner,
  });
  /** The agent's id: `--by` or WEAVER_AGENT. Every record it writes names it. */
  const agentOf = (o: Agent): string => {
    if (!o.by) throw new Error("name the agent: --by <id> or WEAVER_AGENT");
    return o.by;
  };
  /** Who a record is from: the person through the agent (`--human`), else the agent. */
  const whoOf = (o: Common & Agent): Who =>
    o.human
      ? { from: "human", by: o.human === true ? o.writer : o.human }
      : { from: "ai", by: agentOf(o) };

  machine(common(program.command("run [ask]")))
    .description(
      "run an ask through plan, fetch, triage, read, extract, check and review; prints the run as JSON",
    )
    .option("--kind <kind>", `one of ${PLAN_KINDS.join(", ")}`, "web")
    .option(
      "--known <line...>",
      "what is known already, one line each, with its URL or ledger id; a line without one is a premise",
    )
    .option(
      "--premise <line...>",
      "what the ask takes as given (a buyer, an offer, a price): the tree tests each",
    )
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
    .option("--resume <run>", "continue an earlier run from the step it stopped on")
    .option("--run <id>", "the new run's id")
    .option("--pause", "stop after each round's review: `weaver steer`, then --resume")
    .action(
      async (
        ask: string | undefined,
        o: Common & {
          kind: string;
          known?: string[];
          premise?: string[];
          steer?: string[];
          site?: string;
          sources?: string[];
          propose?: string[];
          url?: string[];
          by: string;
          resume?: string;
          run?: string;
          pause?: boolean;
        } & Machine,
      ) => {
        if (!ask && !o.resume) throw new Error("run needs an ask, or --resume <run>");
        const kind = kindOf(o.kind);
        const s = setup(o);
        const { ledger, sources } = s;
        if (o.url?.length)
          sources.set(
            "paste",
            paste(
              o.url.map((url) => ({ url })),
              o.by,
            ),
          );
        const planFile = await planFileOf(
          ledger,
          sources,
          kind,
          o.sources,
          o.url?.length ? ["paste"] : [],
        );
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
        const engineDeps = depsOf(s, o.writer);
        const options = {
          ...(ask
            ? {
                ask: {
                  text: ask,
                  kind,
                  known: o.known ?? [],
                  premises: o.premise ?? [],
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
            `${id}: paused after round ${state.edges.length}; weaver add steer ${id} "<their words>" --human, then weaver run --resume ${id} --pause`,
          );
        if (result?.parked)
          console.error(
            `${id}: ${result.parked}; weaver run --resume ${id} goes one more round, weaver plan --run ${id} opens it by hand`,
          );
        const cost = costOf(state.spends);
        // The last review's word: what the ask still lacks, or that it is answered.
        const last = state.edges.at(-1);
        if (last) console.error(`${id}: ${last.next}: ${last.why}`);
        console.error(`${id}: ${cost.line}`);
        console.log(
          JSON.stringify(
            {
              run: id,
              rounds: state.round,
              cost: cost.total,
              finished: result?.finished ?? false,
              ...(result?.paused ? { paused: true } : {}),
              ...(result?.parked ? { parked: result.parked } : {}),
              note: result ? result.note : "stopped on a transient failure: --resume to go on",
              ...(last ? { edge: { next: last.next, why: last.why } } : {}),
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
        if (!result?.finished && !result?.paused && !result?.parked) process.exitCode = 2;
      },
    );

  agent(machine(common(program.command("plan [ask]"))))
    .description(
      "open a round: a new run from an ask, or the next round of --run after an edge that said again. Prints the run id",
    )
    .option("--run <id>", "the run whose next round to open")
    .option("--kind <kind>", `one of ${PLAN_KINDS.join(", ")}`, "web")
    .option(
      "--known <line...>",
      "what is known already, one line each, with its URL or ledger id; a line without one is a premise",
    )
    .option(
      "--premise <line...>",
      "what the ask takes as given (a buyer, an offer, a price): the tree tests each",
    )
    .option("--site <host>", "the site the ask is about")
    .option(
      "--sources <name...>",
      "the allow-list for this run (default: the plan file's, as far as this machine has them)",
    )
    .action(
      async (
        ask: string | undefined,
        o: Common &
          Machine &
          Agent & {
            run?: string;
            kind: string;
            known?: string[];
            premise?: string[];
            site?: string;
            sources?: string[];
          },
      ) => {
        if (!ask && !o.run) throw new Error("plan needs an ask, or --run <run>");
        const s = setup(o);
        const kind = o.run
          ? (fold(o.run, await s.ledger.trace(o.run)).snapshot?.ask.kind ?? kindOf(o.kind))
          : kindOf(o.kind);
        const planFile = await planFileOf(s.ledger, s.sources, kind, o.sources);
        printDid(
          await planRound(depsOf(s, agentOf(o)), {
            ...(o.run ? { run: o.run } : {}),
            ...(ask
              ? {
                  ask: {
                    text: ask,
                    kind,
                    known: o.known ?? [],
                    premises: o.premise ?? [],
                    ...(o.site ? { site: o.site } : {}),
                  },
                }
              : {}),
            planFile,
            model: s.model?.id ?? null,
          }),
        );
      },
    );

  agent(machine(common(program.command("search <run> [terms]"))))
    .description(
      "one query in the agent's name, then every searcher on every unsearched query of the round; the new hits as JSON. No terms: on stdin, a JSON array of {terms, why, site?}, or a tree {facets: [{name, why, tries: [[{terms, why, site?}]]}]}: one tier. First call: every facet's first try. After triage, the same tree again: the next try of each facet under the guide's thin in kept hits; a facet with uncalled hits waits",
    )
    .option("--why <why>", "why this query serves the ask")
    .option("--site <host>", "keep the query on one host")
    .option("--facet <name>", "the tree's facet this query serves")
    .option("--all", "tree: the next try of every facet that has one, whatever triage kept")
    .action(
      async (
        runId: string,
        terms: string | undefined,
        o: Common &
          Machine &
          Agent & { why?: string; site?: string; facet?: string; all?: boolean },
      ) => {
        if (!terms && process.stdin.isTTY)
          throw new Error("search: terms, or a JSON array of {terms, why} or a tree on stdin");
        const s = setup(o);
        const deps = depsOf(s, agentOf(o));
        if (terms) {
          const q: QueryInput = {
            terms,
            why: o.why ?? "",
            ...(o.site ? { site: o.site } : {}),
            ...(o.facet ? { facet: o.facet } : {}),
          };
          printDid(await search(deps, runId, [q], whoOf(o)));
          return;
        }
        const input = JSON.parse(await stdinText()) as QueryInput[] | QueryTree;
        if (Array.isArray(input)) {
          if (!input.length) throw new Error("search: no queries");
          printDid(await search(deps, runId, input, whoOf(o)));
          return;
        }
        const did = await searchTree(deps, runId, QueryTree.parse(input), whoOf(o), {
          all: o.all ?? false,
        });
        printDid(did);
      },
    );

  common(program.command("show <run> <document>"))
    .description("a document's text as the run stored it, for the agent to read itself")
    .option("--head <chars>", "only the first N characters", Number)
    .action(async (runId: string, document: string, o: Common & { head?: number }) => {
      const ledger = ledgerOf(o);
      const state = fold(runId, await ledger.trace(runId));
      const d = state.documents.find((x) => x.id === document);
      if (!d) throw new Error(`run ${runId}: no document ${document}`);
      console.error(
        `${d.id} ${d.url}${d.title ? ` | ${d.title}` : ""}${d.date ? ` | ${d.date}` : ""} | ${d.text.length} chars`,
      );
      console.log(o.head ? d.text.slice(0, o.head) : d.text);
    });

  agent(machine(common(program.command("open <run> [hit...]"))))
    .description(
      "keep the hits named (and a hit per --url), then read every kept hit of the run that has no document yet",
    )
    .option("--url <url...>", "pages the agent names itself")
    .option("--why <why>", "why read these (with hits or --url)")
    .option(
      "--with <source...>",
      "open sources this machine has that the run's allow-list lacks (`sources` lists them)",
    )
    .action(
      async (
        runId: string,
        hits: string[],
        o: Common & Machine & Agent & { url?: string[]; why?: string; with?: string[] },
      ) => {
        const s = setup(o);
        printDid(
          await open(
            depsOf(s, agentOf(o)),
            runId,
            {
              hits,
              ...(o.url ? { urls: o.url } : {}),
              ...(o.why ? { why: o.why } : {}),
              ...(o.with ? { with: o.with } : {}),
            },
            whoOf(o),
          ),
        );
      },
    );

  agent(machine(common(program.command("extract <run> [document...]"))))
    .description(
      "the extractor (a model behind the quote gate) over the documents named, else every one without a verdict; findings as JSON",
    )
    .action(async (runId: string, documents: string[], o: Common & Machine & Agent) => {
      const s = setup(o);
      printDid(
        await extract(depsOf(s, agentOf(o)), runId, documents.length ? documents : undefined),
      );
    });

  agent(machine(common(program.command("check <run> [finding...]"))))
    .description(
      "a model reads each finding against its document: the findings named, else a sample spread across documents. One that fails gets a drop call",
    )
    .option("-n <n>", "the sample's size (default: the budget's checks)", (v) => Number(v))
    .action(
      async (runId: string, findings: string[], o: Common & Machine & Agent & { n?: number }) => {
        const s = setup(o);
        printDid(
          await check(depsOf(s, agentOf(o)), runId, {
            ...(findings.length ? { findings } : {}),
            ...(o.n !== undefined ? { n: o.n } : {}),
          }),
        );
      },
    );

  const added = async (o: Common & Agent, runId: string, a: Addition) => {
    const s = { ledger: ledgerOf(o), sources: registry(), model: null };
    const { record, warnings } = await add(depsOf(s, agentOf(o)), runId, a, whoOf(o));
    for (const w of warnings) console.error(`${runId}: ${w}`);
    console.log(JSON.stringify(record));
  };
  const adds = program
    .command("add")
    .description("one record by hand, in the agent's name or (--human) the person's");
  agent(common(adds.command("query <run> <terms>")))
    .description("a query for the next search")
    .requiredOption("--why <why>", "why it serves the ask")
    .option("--site <host>")
    .option("--facet <name>", "the tree's facet it serves")
    .action(
      (
        runId: string,
        terms: string,
        o: Common & Agent & { why: string; site?: string; facet?: string },
      ) =>
        added(o, runId, {
          type: "query",
          terms,
          why: o.why,
          ...(o.site ? { site: o.site } : {}),
          ...(o.facet ? { facet: o.facet } : {}),
        }),
    );
  agent(common(adds.command("check <run> <finding>")))
    .description(
      "the agent's own check of a finding against its document: --ok or --fail (a fail also drops it)",
    )
    .option("--ok", "the quote backs the sentence")
    .option("--fail", "it does not")
    .requiredOption("--why <why>")
    .action(
      (
        runId: string,
        finding: string,
        o: Common & Agent & { ok?: boolean; fail?: boolean; why: string },
      ) => {
        if (o.ok === o.fail) throw new Error("check: --ok or --fail");
        return added(o, runId, { type: "check", on: finding, ok: !!o.ok, why: o.why });
      },
    );
  agent(common(adds.command("finding <run> <document>")))
    .description(
      "a finding the agent read itself: the sentence and its quote, which must be on the document word for word",
    )
    .requiredOption("--text <sentence>", "one plain sentence")
    .requiredOption("--quote <quote>", "copied from the document")
    .action(
      (runId: string, document: string, o: Common & Agent & { text: string; quote: string }) =>
        added(o, runId, { type: "finding", document, text: o.text, quote: o.quote }),
    );
  agent(common(adds.command("call <run> <on> <verdict>")))
    .description("keep or drop a hit (read it or not) or a finding, with why")
    .requiredOption("--why <why>")
    .action((runId: string, on: string, verdict: string, o: Common & Agent & { why: string }) => {
      if (verdict !== "keep" && verdict !== "drop") throw new Error("verdict: keep or drop");
      return added(o, runId, { type: "call", on, verdict, why: o.why });
    });
  agent(common(adds.command("edge <run> <next>")))
    .description("the round's edge: again (a new round), stop, or back --to <step>")
    .requiredOption("--why <why>")
    .option("--to <step>", "with back: plan, fetch, triage, read or extract")
    .action((runId: string, next: string, o: Common & Agent & { why: string; to?: string }) => {
      if (next !== "again" && next !== "stop" && next !== "back")
        throw new Error("next: again, stop or back");
      return added(o, runId, {
        type: "edge",
        next,
        ...(o.to ? { to: RavenStep.parse(o.to) } : {}),
        why: o.why,
      });
    });
  agent(common(adds.command("steer <run> <text>")))
    .description("what the person says to the run: first in every prompt after it (always --human)")
    .action((runId: string, text: string, o: Common & Agent) =>
      added({ ...o, human: o.human ?? true }, runId, { type: "steer", text }),
    );
  agent(common(adds.command("gap <run> <text>")))
    .description("what the round still lacks")
    .option("--on <id>", "the query or hit it is about")
    .action((runId: string, text: string, o: Common & Agent & { on?: string }) =>
      added(o, runId, { type: "gap", note: text, ...(o.on ? { on: o.on } : {}) }),
    );
  agent(common(adds.command("pattern <run> <text>")))
    .description(
      "what several kept findings say together: one sentence; the count of distinct sites is computed",
    )
    .requiredOption("--on <finding...>", "the findings it rests on")
    .action((runId: string, text: string, o: Common & Agent & { on: string[] }) =>
      added(o, runId, { type: "pattern", text, findings: o.on }),
    );

  agent(common(adds.command("draft <run>")))
    .description(
      "a rough draft over the run's kept findings and patterns, on stdin as JSON [{title, body, cites: [finding or pattern id...]}]: an item that cites nothing kept, or has a number no cited finding has, is dropped. A draft, never the final",
    )
    .requiredOption("--for <what>", "what it is for: a decision memo, an SOP outline")
    .action(async (runId: string, o: Common & Agent & { for: string }) => {
      const parsed: unknown = JSON.parse(await stdinText());
      const items = Array.isArray(parsed) ? parsed : (parsed as { items?: unknown } | null)?.items;
      if (!Array.isArray(items))
        throw new Error("draft: stdin is a JSON array of items, or {items}");
      return added(o, runId, { type: "draft", for: o.for, items: items as DraftInput[] });
    });

  common(program.command("learn <kind>"))
    .description(
      "the next version of a kind's plan file, from what a run taught: sources, budget, age, a prompt; --show prints the current one",
    )
    .option("--show", "print the current plan file, write nothing")
    .option("--sources <name...>", "the allow-list, in order of preference")
    .option("--queries <n>", "queries per round", Number)
    .option("--reads <n>", "reads per round", Number)
    .option("--rounds <n>", "rounds before the runner parks", Number)
    .option("--checks <n>", "findings checked per round", Number)
    .option("--age <sentence>", "how much a source's age counts")
    .option("--propose <file>", "the propose prompt, from a file")
    .option("--triage <file>", "the triage prompt, from a file")
    .option("--review <file>", "the review prompt, from a file")
    .option("--thin <n>", "new hits under which a tree's try is thin, so the next try runs", Number)
    .option("--tree <file>", "the query tree's guide, as JSON {facets: [{name, why}], thin}")
    .action(
      async (
        kind: string,
        o: Common & {
          show?: boolean;
          sources?: string[];
          queries?: number;
          reads?: number;
          rounds?: number;
          checks?: number;
          age?: string;
          propose?: string;
          triage?: string;
          review?: string;
          thin?: number;
          tree?: string;
        },
      ) => {
        const k = kindOf(kind);
        const ledger = ledgerOf(o);
        const current = (await ledger.readPlan?.(k)) ?? defaultPlanFile(k);
        if (o.show) {
          console.log(JSON.stringify(current, null, 2));
          return;
        }
        if (!ledger.writePlan) throw new Error("this ledger keeps no plan files");
        const text = (file: string) => readFile(file, "utf8");
        const budget = {
          ...(o.queries !== undefined ? { queries: o.queries } : {}),
          ...(o.reads !== undefined ? { reads: o.reads } : {}),
          ...(o.rounds !== undefined ? { rounds: o.rounds } : {}),
          ...(o.checks !== undefined ? { checks: o.checks } : {}),
        };
        const next = tunePlan(current, {
          ...(o.sources ? { sources: o.sources } : {}),
          budget,
          ...(o.age !== undefined ? { age: o.age } : {}),
          ...(o.propose ? { propose: await text(o.propose) } : {}),
          ...(o.triage ? { triage: await text(o.triage) } : {}),
          ...(o.review ? { review: await text(o.review) } : {}),
          ...(o.tree
            ? { tree: TreeGuide.parse(JSON.parse(await text(o.tree))) }
            : o.thin !== undefined
              ? { tree: { ...treeOf(current), thin: o.thin } }
              : {}),
        });
        const path = await ledger.writePlan(next);
        console.error(`${k}: plan file version ${next.version} at ${path}`);
        console.log(JSON.stringify(next, null, 2));
      },
    );

  common(program.command("brief <run>"))
    .description(
      "the run as the agent needs it: the ask, what is known, what the last round left open, hits to call, documents to extract, findings, checks, edges, yield, cost",
    )
    .action(async (runId: string, o: Common) => {
      const s = { ledger: ledgerOf(o), sources: registry(), model: null };
      console.log(JSON.stringify(await brief(depsOf(s, o.writer), runId), null, 2));
    });

  common(program.command("recall <terms...>"))
    .description(
      "what earlier runs found on these terms: each finding with its quote, URL, source date and run, best match first; dropped findings left out",
    )
    .option("-n <n>", "at most this many (default 20)", Number)
    .option("--not <run>", "leave out this run (the one asking)")
    .option("--kind <kind>", "only runs of this ask kind")
    .option("--also <dir...>", "more ledger folders to read with --ledger (one per day)")
    .action(
      async (
        terms: string[],
        o: Common & { n?: number; not?: string; kind?: string; also?: string[] },
      ) => {
        const ledgers = [
          ledgerOf(o),
          ...(o.also ?? []).map((dir) => ledgerOf({ ...o, ledger: dir })),
        ];
        const found = await recall(joined(ledgers), terms.join(" "), {
          ...(o.n !== undefined ? { n: o.n } : {}),
          ...(o.not ? { not: o.not } : {}),
          ...(o.kind ? { kind: kindOf(o.kind) } : {}),
        });
        console.log(JSON.stringify(found, null, 2));
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
