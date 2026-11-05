/**
 * The engine from a shell, one step per command for the agent that drives it: `plan`, `search`,
 * `open`, `extract`, `check`, `add`, `brief`, `trace` a run, `sources` on this
 * machine. Every command prints JSON. The ledger is a folder (`--ledger`, BIRDWATCH_LEDGER, default `./ledger`); a
 * writer names this terminal's file in it (`--writer`, BIRDWATCH_WRITER, default the user name).
 * The model is a `@wrenautomation/models` spec: `anthropic:sonnet` by default (Claude Sonnet direct,
 * ANTHROPIC_API_KEY), `gateway[:alias]`, `gemini`, `claude-code`, `command:<cmd>` and the rest
 * of its grammar. A host with its own ledger, sources or
 * model passes them in `EngineCliDeps`; wren's `research` command is these commands over
 * Postgres. A step that stops on a transient failure (a 429, a 5xx, a dropped connection) exits
 * with its note; the agent runs it again, and it skips what its records show done.
 */

import { mkdir, readFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import type { Model } from "@wrenautomation/models";
import { anthropic } from "@wrenautomation/models";
import { type Judge, judgeFromSpec } from "@wrenautomation/models/judge";
import { modelFromSpec } from "@wrenautomation/models/spec";
import { brandOf } from "@wrenautomation/read/brand";
import type { LadderClient } from "@wrenautomation/read/fetch";
import { PoliteFetcher, userAgent } from "@wrenautomation/read/fetch";
import { dirStore, speechHere } from "@wrenautomation/read/video";
import type { Command } from "commander";
import { z } from "zod";
import type { Extractor } from "../document/index.js";
import { claimExtractor } from "../document/index.js";
import {
  type Acceptance,
  type Addition,
  accept,
  add,
  brief,
  check,
  costOf,
  type Did,
  type DraftInput,
  extract,
  fold,
  follow,
  joined,
  open,
  planRound,
  type QueryInput,
  RESERVED,
  recall,
  registry,
  type Source,
  type Sources,
  search,
  searchTree,
  tunePlan,
  type Who,
} from "../engine/index.js";
import {
  type AskKind,
  Criterion,
  defaultPlanFile,
  PLAN_KINDS,
  type PlanFile,
  QueryTree,
  TreeGuide,
  treeOf,
} from "../engine/plan.js";
import type { RunState } from "../engine/state.js";
import { RUNS } from "../engine/tree.js";
import { Step as PlanStep } from "../engine/types.js";
import { webOf } from "../engine/web.js";
import {
  FilesLedger,
  FollowAs,
  type Ledger,
  type Problem,
  SOURCE_CLASSES,
  SourceClass,
  ulids,
} from "../ledger/index.js";
import {
  accountsFrom,
  arxivSource,
  exa,
  facebookSource,
  fetcherSource,
  googleSource,
  hn,
  httpLadderClient,
  ingressLadderClient,
  ladderSource,
  ledgerSource,
  linkedinSource,
  perplexity,
  redditSource,
  searxng,
  youtubeApi,
  youtubeSee,
  ytdlpSource,
} from "../sources/index.js";
import {
  allChanges,
  groupOf,
  type LedgerSet,
  SERVE_ORIGINS,
  SERVE_PORT,
  serveApp,
  watchRuns,
} from "./serve.js";

const DEFAULT_MODEL = "anthropic:sonnet";

export { costOf };

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

/** `name=question` lines as criteria; a name the judge already asks, or a repeat, fails. */
export function criteriaOf(lines: readonly string[] | undefined): Criterion[] {
  const out: Criterion[] = [];
  for (const line of lines ?? []) {
    const at = line.indexOf("=");
    const c = Criterion.safeParse({
      name: line.slice(0, at).trim(),
      question: line.slice(at + 1).trim(),
    });
    if (at < 1 || !c.success)
      throw new Error(`--criterion ${line}: want name=question, name in a-z0-9_`);
    if (RESERVED.has(c.data.name) || out.some((x) => x.name === c.data.name))
      throw new Error(`--criterion ${c.data.name}: the name is taken`);
    out.push(c.data);
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
  /** The judge for a `--judge` spec; the default is models' `judgeFromSpec`. */
  judge?(spec: string, printed: NodeJS.ProcessEnv): Judge | null;
  extractor?: Extractor;
}

const filesLedger = (o: Common) => new FilesLedger(o.ledger, o.writer);

/** Reads the frames of a video the agent asks to see: each one's text and what it shows. */
const SEE_MODEL = "sonnet";

/** autobrowse from the environment: a worker by URL, else through Restate ingress; null for none. */
export function sitesHere(printed: NodeJS.ProcessEnv): LadderClient | null {
  if (printed.AUTOBROWSE_URL)
    return httpLadderClient({
      url: printed.AUTOBROWSE_URL,
      token: printed.AUTOBROWSE_TOKEN ?? null,
    });
  if (!printed.RESTATE_INGRESS_URL) return null;
  return ingressLadderClient({
    url: printed.RESTATE_INGRESS_URL,
    token: printed.RESTATE_AUTH_TOKEN ?? null,
    ...(printed.AUTOBROWSE_SERVICE ? { service: printed.AUTOBROWSE_SERVICE } : {}),
    caller: `birdwatch:${printed.BIRDWATCH_AGENT ?? "cli"}`,
  });
}

/** The sources this machine can run, from the environment. */
export function sourcesHere(
  printed: NodeJS.ProcessEnv,
  ledger: FilesLedger,
  ytDlp: string,
  warn: (line: string) => void = (l) => console.error(l),
): Sources {
  const out: Source[] = [];
  // one ear for both YouTube sources: local whisper, else Cohere
  const ear = speechHere(keys(printed, "COHERE_API_KEY"));
  if (printed.SEARXNG_URL)
    out.push(
      searxng({
        url: printed.SEARXNG_URL,
        ...(printed.SEARXNG_TOKEN ? { token: printed.SEARXNG_TOKEN } : {}),
      }),
    );
  const exaKeys = keys(printed, "EXA_API_KEY");
  if (exaKeys.length) out.push(exa({ keys: exaKeys }));
  const pplxKeys = keys(printed, "PERPLEXITY_API_KEY");
  if (pplxKeys.length) out.push(perplexity({ keys: pplxKeys }));
  out.push(hn());
  // hits through the Data API when there is a key; an open reads captions, else Cohere hears the audio
  out.push(
    ytdlpSource({
      ytDlp,
      ...(printed.YOUTUBE_API_KEY ? { api: youtubeApi({ key: printed.YOUTUBE_API_KEY }) } : {}),
      ...(ear ? { ear } : {}),
      warn,
    }),
  );
  // what a video shows, on the agent's ask: Claude on the frames, Cohere hears a video with no captions
  const claudeKeys = keys(printed, "ANTHROPIC_API_KEY");
  if (claudeKeys.length)
    out.push(
      youtubeSee({
        ytDlp,
        eye: anthropic({ key: claudeKeys, model: SEE_MODEL }),
        ...(ear ? { ear } : {}),
        store: dirStore(printed.BIRDWATCH_MEDIA ?? join(homedir(), ".cache", "birdwatch", "media")),
      }),
    );
  if (printed.BIRDWATCH_CONTACT) {
    out.push(fetcherSource({ fetcher: new PoliteFetcher(userAgent(printed.BIRDWATCH_CONTACT)) }));
    const categories = (printed.BIRDWATCH_ARXIV_CATEGORIES ?? "")
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
    out.push(
      arxivSource({
        agent: userAgent(printed.BIRDWATCH_CONTACT),
        categories,
        ...(printed.OPENALEX_API_KEY ? { openalexKey: printed.OPENALEX_API_KEY } : {}),
        ...(printed.SEMANTIC_SCHOLAR_API_KEY ? { s2Key: printed.SEMANTIC_SCHOLAR_API_KEY } : {}),
      }),
    );
  } else
    warn("no BIRDWATCH_CONTACT (an email address or URL for site operators): pages stay unopened");
  const sites = sitesHere(printed);
  if (sites) {
    // The account each site reader signs in as: the caller's choice, never a default here.
    const accounts = accountsFrom(printed.BIRDWATCH_ACCOUNTS);
    const reddit = accounts.get("reddit");
    out.push(
      ladderSource({ sites }),
      redditSource({ sites, ...(reddit ? { account: reddit } : {}) }),
      facebookSource({ sites }),
      googleSource({ sites }),
    );
    // LinkedIn reads only as a named account: the bare `linkedin` is a person's own profile.
    const linkedin = accounts.get("linkedin");
    if (linkedin) out.push(linkedinSource({ sites, account: linkedin }));
  }
  out.push(ledgerSource(ledger));
  return registry(...out);
}

/**
 * The run's allow-list: the names wanted that exist here. `opens`: unless the list was given by
 * hand, every other opener here, let in to open and follow, never to search (arxiv searched every
 * web run when it joined the list). A name wanted that this machine lacks is dropped with a line on stderr.
 */
export function allowList(
  sources: Sources,
  wanted: readonly string[],
  byHand: boolean,
  warn: (line: string) => void = (l) => console.error(l),
): { sources: string[]; opens: string[] } {
  const out: string[] = [];
  for (const name of wanted) {
    if (sources.has(name)) out.push(name);
    else warn(`no source named ${name} here: skipped`);
  }
  const opens = byHand
    ? []
    : [...sources.values()].filter((s) => s.open && !out.includes(s.name)).map((s) => s.name);
  return { sources: out, opens };
}

/** The options a command that runs sources or a model takes. */
interface Machine {
  model: string | false;
  judge: string | false;
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

/** Prints what a command did as JSON; a step that gave up exits 2. */
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
  // defaults resolve in preAction: a root `--ledger` before the command name must win over env
  const common = (c: Command) =>
    c
      .option("--ledger <dir>", "the ledger folder (default: BIRDWATCH_LEDGER, else ./ledger)")
      .option(
        "--writer <name>",
        "this terminal's file in the ledger (default: BIRDWATCH_WRITER, else the user)",
      );
  if (!program.options.some((x) => x.long === "--ledger")) common(program);
  program.hook("preAction", (root, cmd) => {
    if (cmd === root || !cmd.options.some((x) => x.long === "--ledger")) return;
    const own = cmd.opts();
    const top = root.opts();
    cmd.setOptionValue(
      "ledger",
      own.ledger ?? top.ledger ?? process.env.BIRDWATCH_LEDGER ?? "./ledger",
    );
    cmd.setOptionValue(
      "writer",
      own.writer ?? top.writer ?? process.env.BIRDWATCH_WRITER ?? userInfo().username,
    );
  });
  const machine = (c: Command) =>
    c
      .option(
        "--model <spec>",
        "a models spec: anthropic[:haiku|sonnet|opus], gateway[:alias], gemini[:id], claude-code, command:<cmd>, ...",
        process.env.BIRDWATCH_MODEL ?? DEFAULT_MODEL,
      )
      .option("--no-model", "no model: nothing extracted or checked")
      .option(
        "--judge <spec>",
        "cheap typed answers on every hit, page and finding (a hint and a router): jev[:model], fake, off",
        process.env.BIRDWATCH_JUDGE ?? (process.env.TYPESAFE_API_KEY ? "jev" : "off"),
      )
      .option("--no-judge", "no judge")
      .option("--yt-dlp <cmd>", "the yt-dlp command", process.env.BIRDWATCH_YTDLP ?? "yt-dlp");
  const agent = (c: Command) =>
    c
      .option("--by <agent>", "the agent's id on what it writes", process.env.BIRDWATCH_AGENT)
      .option(
        "--human [name]",
        "the record is the person's word, relayed: from human, by their name (default: the writer)",
      );
  /** The ledger, this machine's sources and the model, from the options. */
  /** The sources this machine runs: the test's, else the environment's. `warn`: where a missing key is said. */
  const sourcesOf = (
    o: Common & { ytDlp?: string },
    ledger: ReturnType<typeof ledgerOf>,
    warn?: (line: string) => void,
  ) =>
    deps.sources
      ? deps.sources(o, ledger)
      : sourcesHere(
          process.env,
          ledger as FilesLedger,
          o.ytDlp ?? process.env.BIRDWATCH_YTDLP ?? "yt-dlp",
          warn,
        );
  const setup = (
    o: Common & Machine,
  ): {
    ledger: ReturnType<typeof ledgerOf>;
    sources: Sources;
    model: Model | null;
    judge: Judge | null;
  } => {
    const ledger = ledgerOf(o);
    const sources = sourcesOf(o, ledger);
    const model: Model | null =
      o.model === false ? null : (deps.model ?? modelFromSpec)(o.model, process.env);
    const judge: Judge | null =
      o.judge === false ? null : (deps.judge ?? judgeFromSpec)(o.judge, process.env);
    return { ledger, sources, model, judge };
  };
  /**
   * The ledger's tuned plan file for the kind (the stock one when none), its sources the run's
   * allow-list: the names given by hand, else `first` then the plan file's, as far as this
   * machine has them. `opens`: the other openers, let in to open and follow only.
   */
  const planFileOf = async (
    ledger: HostLedger,
    sources: Sources,
    kind: AskKind,
    byHand: string[] | undefined,
    first: string[] = [],
  ): Promise<{ planFile: PlanFile; opens: string[] }> => {
    const stock = defaultPlanFile(kind);
    const tuned = (await ledger.readPlan?.(kind)) ?? stock;
    if (tuned.version < stock.version)
      console.error(
        `plan file ${kind} is version ${tuned.version}; birdwatch ships ${stock.version}: delete it to take the new one`,
      );
    const wanted = byHand ?? [...first, ...tuned.sources];
    // A run narrows to the plan file's sources, so the run's allow-list goes in as the plan file's.
    const { sources: list, opens } = allowList(sources, wanted, !!byHand);
    return { planFile: { ...tuned, sources: list }, opens };
  };
  const depsOf = (s: ReturnType<typeof setup>, writer: string) => ({
    ...s,
    extractor: deps.extractor ?? claimExtractor,
    clock: () => new Date(),
    ids: ulids(),
    writer,
    progress: (line: string) => console.error(line),
  });
  /** The agent's id: `--by` or BIRDWATCH_AGENT. Every record it writes names it. */
  const agentOf = (o: Agent): string => {
    if (!o.by) throw new Error("name the agent: --by <id> or BIRDWATCH_AGENT");
    return o.by;
  };
  /** Who a record is from: the person through the agent (`--human`), else the agent. */
  const whoOf = (o: Common & Agent): Who =>
    o.human
      ? { from: "human", by: o.human === true ? o.writer : o.human }
      : { from: "ai", by: agentOf(o) };

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
    .option(
      "--criterion <name=question...>",
      'a yes-or-no label on what a source is or covers (code="Is code released?"): the judge asks it on every hit and every page read whole; it orders, never drops',
    )
    .option("--site <host>", "the site the ask is about")
    .option(
      "--sources <name...>",
      "the allow-list for this run (default: the plan file's, as far as this machine has them)",
    )
    .option(
      "--parent <run>",
      "a new run's parent: this run is a child of it (one niche of a wide run)",
    )
    .option("--why <why>", "with --parent: why this child")
    .option(
      "--reads <n>",
      "a new root only: the whole tree's read cap (else the plan file's runs.reads, else from the budget); a child takes its root's",
      (v) => Number(v),
    )
    .action(
      async (
        ask: string | undefined,
        o: Common &
          Machine &
          Agent & {
            parent?: string;
            why?: string;
            run?: string;
            kind: string;
            known?: string[];
            premise?: string[];
            criterion?: string[];
            site?: string;
            sources?: string[];
            reads?: number;
          },
      ) => {
        if (!ask && !o.run) throw new Error("plan needs an ask, or --run <run>");
        if (o.reads !== undefined && (o.run || o.parent))
          throw new Error(
            "plan --reads: a new root only; to raise a tree's cap, add cap <root> --human",
          );
        if (o.reads !== undefined && !(Number.isInteger(o.reads) && o.reads > 0))
          throw new Error(`plan --reads: a whole number above 0; got ${o.reads}`);
        const s = setup(o);
        const kind = o.run
          ? (fold(o.run, await s.ledger.trace(o.run)).snapshot?.ask.kind ?? kindOf(o.kind))
          : kindOf(o.kind);
        const { planFile: file, opens } = await planFileOf(s.ledger, s.sources, kind, o.sources);
        const planFile =
          o.reads === undefined
            ? file
            : { ...file, runs: { ...RUNS, ...file.runs, reads: o.reads } };
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
                    criteria: criteriaOf(o.criterion),
                    ...(o.site ? { site: o.site } : {}),
                  },
                }
              : {}),
            planFile,
            opens,
            model: s.model?.id ?? null,
            ...(o.parent ? { parent: { run: o.parent, why: o.why ?? "" } } : {}),
          }),
        );
      },
    );

  agent(machine(common(program.command("search <run> [terms]"))))
    .description(
      "one query in the agent's name, then every searcher on every unsearched query of the round; the new hits as JSON. No terms: on stdin, a JSON array of {terms, why, site?, preset?}, or a tree {facets: [{name, why, tries: [[{terms, why, site?, preset?}]]}]}: one tier. First call: every facet's first try. After triage, the same tree again: the next try of each facet under the guide's thin in kept hits; a facet with uncalled hits waits",
    )
    .option("--why <why>", "why this query serves the ask")
    .option("--site <host>", "keep the query on one host")
    .option(
      "--preset <preset>",
      "sort and window: latest or top, day, week, month or year, or paired (top-week); only sources that take presets search it",
    )
    .option("--facet <name>", "the tree's facet this query serves")
    .option("--all", "tree: the next try of every facet that has one, whatever triage kept")
    .action(
      async (
        runId: string,
        terms: string | undefined,
        o: Common &
          Machine &
          Agent & { why?: string; site?: string; preset?: string; facet?: string; all?: boolean },
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
            ...(o.preset ? { preset: o.preset } : {}),
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
      "keep the hits named (and a hit per --url) and read them; no names: read every kept hit of the run that has no document yet",
    )
    .option("--url <url...>", "pages the agent names itself")
    .option("--why <why>", "why read these (with hits or --url)")
    .option(
      "--with <source...>",
      "open sources this machine has that the run's allow-list lacks (`sources` lists them)",
    )
    .option(
      "--see",
      "read what the named videos show, frame by frame (downloaded; Claude reads the frames, ~$0.30 for 10 min): only a video worth it whose captions lean on the screen",
    )
    .option(
      "--survey <query>",
      "a channel survey (the brief's `surveys`): read its first --top uploads by views over the channel's median",
    )
    .option("--top <k>", "how many of the survey to read (default 5)", Number)
    .action(
      async (
        runId: string,
        hits: string[],
        o: Common &
          Machine &
          Agent & {
            url?: string[];
            why?: string;
            with?: string[];
            see?: boolean;
            survey?: string;
            top?: number;
          },
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
              ...(o.see ? { see: true } : {}),
              ...(o.survey ? { survey: { query: o.survey, top: o.top ?? 5 } } : {}),
            },
            whoOf(o),
          ),
        );
      },
    );

  agent(machine(common(program.command("follow <run> [url]"))))
    .description(
      `what a person does after a good page: --as posts (its channel's or author's own posts: a YouTube channel or video, a TikTok profile, a Reddit user), similar (pages like it), refs (what a paper cites) or citers (what cites it, most cited first); the hits go through the same calls and reads.`,
    )
    .requiredOption("--as <as>", "posts, similar, refs or citers")
    .requiredOption("--why <why>", "why this page's neighbors may answer the ask")
    .option("--from <document>", "the read page that led here (its URL when no url is given)")
    .option("--with <source...>", "follow sources this machine has that the run's allow-list lacks")
    .option(
      "-n <n>",
      "how many to list (default 30, at most 1000): a channel survey lists its uploads whole; the brief's surveys rank them over the channel's median",
      Number,
    )
    .option("--since <day>", "posts on or after this day (YYYY-MM-DD); YouTube only")
    .option(
      "--q <words>",
      "only posts inside the channel that match these words (YouTube search: 100 units per 50)",
    )
    .action(
      async (
        runId: string,
        url: string | undefined,
        o: Common &
          Machine &
          Agent & {
            as: string;
            why: string;
            from?: string;
            with?: string[];
            n?: number;
            since?: string;
            q?: string;
          },
      ) => {
        const s = setup(o);
        printDid(
          await follow(
            depsOf(s, agentOf(o)),
            runId,
            {
              as: FollowAs.parse(o.as),
              why: o.why,
              ...(url ? { url } : {}),
              ...(o.from ? { document: o.from } : {}),
              ...(o.with ? { with: o.with } : {}),
              ...(o.n !== undefined ? { n: o.n } : {}),
              ...(o.since ? { since: o.since } : {}),
              ...(o.q ? { q: o.q } : {}),
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
    .option(
      "--limit <n>",
      "at most n documents this call (a shell with a time cap); run it again for the rest",
      (v) => Number(v),
    )
    .action(
      async (
        runId: string,
        documents: string[],
        o: Common & Machine & Agent & { limit?: number },
      ) => {
        const s = setup(o);
        printDid(
          await extract(
            depsOf(s, agentOf(o)),
            runId,
            documents.length ? documents : undefined,
            o.limit,
          ),
        );
      },
    );

  agent(machine(common(program.command("check <run> [finding...]"))))
    .description(
      "a model reads each finding against its document: the findings named, else with --patterns every unchecked finding a pattern rests on, else a sample spread across documents. The judge first reads every kept finding; each one it doubts joins the sample. One that fails gets a drop call",
    )
    .option(
      "-n <n>",
      "the sample's size (default: the budget's checks or a tenth of the kept findings, whichever is more)",
      (v) => Number(v),
    )
    .option("--patterns", "every unchecked finding a pattern rests on")
    .action(
      async (
        runId: string,
        findings: string[],
        o: Common & Machine & Agent & { n?: number; patterns?: boolean },
      ) => {
        const s = setup(o);
        printDid(
          await check(depsOf(s, agentOf(o)), runId, {
            ...(findings.length ? { findings } : {}),
            ...(o.n !== undefined ? { n: o.n } : {}),
            ...(o.patterns ? { patterns: true } : {}),
          }),
        );
      },
    );

  const added = async (o: Common & Agent, runId: string, a: Addition) => {
    const s = { ledger: ledgerOf(o), sources: registry(), model: null, judge: null };
    const { record, warnings, spread } = await add(depsOf(s, agentOf(o)), runId, a, whoOf(o));
    for (const w of warnings) console.error(`${runId}: ${w}`);
    console.log(JSON.stringify(spread ? { ...record, ...spread } : record));
  };
  const adds = program
    .command("add")
    .description("one record by hand, in the agent's name or (--human) the person's");
  agent(common(adds.command("query <run> <terms>")))
    .description("a query for the next search")
    .requiredOption("--why <why>", "why it serves the ask")
    .option("--site <host>")
    .option(
      "--preset <preset>",
      "sort and window (top-week); only sources that take presets search it",
    )
    .option("--facet <name>", "the tree's facet it serves")
    .action(
      (
        runId: string,
        terms: string,
        o: Common & Agent & { why: string; site?: string; preset?: string; facet?: string },
      ) =>
        added(o, runId, {
          type: "query",
          terms,
          why: o.why,
          ...(o.site ? { site: o.site } : {}),
          ...(o.preset ? { preset: o.preset } : {}),
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
  agent(common(adds.command("call <run> [on] [verdict]")))
    .description(
      'keep or drop a hit (read it or not) or a finding, with why. No <on>: on stdin, a JSON array of {"on","verdict","why"}, one record each',
    )
    .option("--why <why>")
    .action(
      async (
        runId: string,
        on: string | undefined,
        verdict: string | undefined,
        o: Common & Agent & { why?: string },
      ) => {
        const calls = on
          ? [{ on, verdict, why: o.why }]
          : z
              .array(z.object({ on: z.string(), verdict: z.string(), why: z.string() }))
              .parse(JSON.parse(await stdinText()));
        // verdicts and whys checked before any write; an unknown id stops at its line
        for (const c of calls) {
          if (c.verdict !== "keep" && c.verdict !== "drop")
            throw new Error(`${c.on}: verdict keep or drop; got ${c.verdict}`);
          if (!c.why?.trim()) throw new Error(`${c.on}: --why`);
        }
        for (const c of calls)
          await added(o, runId, {
            type: "call",
            on: c.on,
            verdict: c.verdict as "keep" | "drop",
            why: c.why as string,
          });
      },
    );
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
        ...(o.to ? { to: PlanStep.parse(o.to) } : {}),
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
    .usage("<run> <text> --on <finding...> [options]")
    .description(
      "what several kept findings say together: one sentence; the count of distinct sites is computed. --on takes findings of this run or of any run under it",
    )
    .requiredOption("--on <finding...>", "the findings it rests on (this run's or its children's)")
    .action((runId: string, text: string, o: Common & Agent & { on: string[] }) =>
      added(o, runId, { type: "pattern", text, findings: o.on }),
    );

  agent(common(adds.command("cap <root> <reads>")))
    .description(
      "raise or lower the pages a whole tree may read, on its root: the person's call (--human), with why",
    )
    .requiredOption("--why <why>")
    .action((runId: string, reads: string, o: Common & Agent & { why: string }) =>
      added(o, runId, { type: "cap", reads: Number(reads), why: o.why }),
    );

  agent(common(adds.command("dead <run> <facet>")))
    .description(
      "give up on a facet, with why: later tries and rounds skip it, and a parent's next plan reads it as a dead end",
    )
    .requiredOption("--why <why>")
    .action((runId: string, facet: string, o: Common & Agent & { why: string }) =>
      added(o, runId, { type: "dead", facet, why: o.why }),
    );

  agent(common(adds.command("person <run> <name>")))
    .description(
      "one person across platforms: their profile URLs and the names they post under. The brief counts kept findings per person; follow each profile's posts",
    )
    .option("--profile <url...>", "a channel, a Substack, an X account, a blog")
    .option("--aka <name...>", "a channel name or handle they post under")
    .requiredOption("--why <why>")
    .action(
      (
        runId: string,
        name: string,
        o: Common & Agent & { profile?: string[]; aka?: string[]; why: string },
      ) =>
        added(o, runId, {
          type: "person",
          name,
          profiles: o.profile ?? [],
          aka: o.aka ?? [],
          why: o.why,
        }),
    );

  agent(common(adds.command("class <run> <on> <class>")))
    .description(
      `what kind of source a document is (its findings take it), or one finding when it differs: ${SOURCE_CLASSES.join(", ")}. Patterns count sites per class`,
    )
    .requiredOption("--why <why>")
    .action((runId: string, on: string, cls: string, o: Common & Agent & { why: string }) =>
      added(o, runId, { type: "class", on, class: SourceClass.parse(cls), why: o.why }),
    );

  agent(common(program.command("accept <run> <take>")))
    .description(
      "take the judge's class guesses over a bar, in your name with your why: `class --min p` classes every unclassed document whose guess is at least p. The judge never keeps or drops a hit: you call each",
    )
    .requiredOption("--why <why>", "why this bar")
    .option("--min <p>", "class: the guess's least probability", (v) => Number(v))
    .action(
      async (runId: string, take: string, o: Common & Agent & { why: string; min?: number }) => {
        if (take !== "class")
          throw new Error(
            `accept <run> class: only class; the judge never keeps or drops a hit, you call each (got "${take}")`,
          );
        if (o.min === undefined) throw new Error("accept class: --min <p>");
        const a: Acceptance = { take, min: o.min, why: o.why };
        const s = { ledger: ledgerOf(o), sources: registry(), model: null, judge: null };
        const out = await accept(depsOf(s, agentOf(o)), runId, a, whoOf(o));
        console.error(`${runId}: ${out.wrote.length} taken, ${out.skipped} under the bar`);
        console.log(JSON.stringify(out, null, 2));
      },
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
    .option("--rounds <n>", "rounds a run should take: a guard rail", Number)
    .option("--checks <n>", "findings checked per round", Number)
    .option("--age <sentence>", "how much a source's age counts")
    .option(
      "--rule <line...>",
      "the rules the agent heeds for this kind, one line each: replaces them all",
    )
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
          rule?: string[];
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
          ...(o.rule ? { rules: o.rule } : {}),
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
      "the run as the agent needs it: the ask, sources (and those missing here), what earlier runs found, what the last round left open, hits to call with their metrics and lift, authors' baselines, documents to extract, findings, checks, edges, yield, cost",
    )
    .action(async (runId: string, o: Common) => {
      // this machine's sources, built not called: the brief names which the run lacks; quiet
      const ledger = ledgerOf(o);
      const sources = sourcesOf(o, ledger, () => undefined);
      const s = { ledger, sources, model: null, judge: null };
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

  /** The ledger and `--also` folders as serve's sets: each run read with its own folder's deps. */
  const setsOf = async (o: Common & { also?: string[] }): Promise<LedgerSet[]> => {
    const roots = [o.ledger, ...(o.also ?? []).filter((r) => r !== o.ledger)];
    await mkdir(`${o.ledger}/runs`, { recursive: true });
    return roots.map((root) => {
      const ledger = new FilesLedger(root, o.writer);
      const deps = depsOf({ ledger, sources: registry(), model: null, judge: null }, o.writer);
      return { group: groupOf(root), deps, runs: () => ledger.runs() };
    });
  };

  common(program.command("serve"))
    .description(
      "ledgers over HTTP for a viewer, read only: GET /runs, /runs/:run, /runs/:run/documents/:doc, /web (every run as one web), and /events (one event per changed run)",
    )
    .option("--port <n>", "the port", (v) => Number(v), SERVE_PORT)
    .option("--host <host>", "the address to bind", "127.0.0.1")
    .option("--origin <url...>", "the pages that may read it, besides any localhost", SERVE_ORIGINS)
    .option("--also <dir...>", "more ledger folders to read beside --ledger")
    .action(
      async (o: Common & { port: number; host: string; origin: string[]; also?: string[] }) => {
        const sets = await setsOf(o);
        const roots = [o.ledger, ...(o.also ?? []).filter((r) => r !== o.ledger)];
        const app = serveApp({
          sets,
          changes: allChanges(...roots.map((r) => watchRuns(r))),
          origins: o.origin,
        });
        serve({ fetch: app.fetch, port: o.port, hostname: o.host }, (a) =>
          console.error(`birdwatch serve: http://${a.address}:${a.port} over ${roots.join(", ")}`),
        );
        await new Promise(() => {});
      },
    );

  common(program.command("web"))
    .description(
      "every run as one web: nodes (run, query, site or channel, page, finding, hub) with fixed positions, and edges",
    )
    .option("--also <dir...>", "more ledger folders to read beside --ledger")
    .option("--json", "the web as JSON (the default prints counts)")
    .action(async (o: Common & { also?: string[]; json?: boolean }) => {
      const sets = await setsOf(o);
      const seen = new Set<string>();
      const runs: { group: string; state: RunState }[] = [];
      for (const set of sets)
        for (const run of await set.runs()) {
          if (seen.has(run)) continue;
          seen.add(run);
          const records = await set.deps.ledger.trace(run);
          if (records.length) runs.push({ group: set.group, state: fold(run, records) });
        }
      const m = webOf(runs);
      if (o.json) return void console.log(JSON.stringify(m));
      const count = new Map<string, number>();
      for (const n of m.nodes) count.set(n.kind, (count.get(n.kind) ?? 0) + 1);
      console.log(
        `${m.nodes.length} nodes, ${m.edges.length} edges: ${[...count].map(([k, v]) => `${v} ${k}`).join(", ")}`,
      );
    });

  program
    .command("brand <url>")
    .description(
      "a site's logo, palette (primary, accent, background, text) and fonts, with confidence: its CSS first, a browser through autobrowse when that is thin. JSON out",
    )
    .option("--static", "read the CSS only: no autobrowse")
    .action(async (url: string, o: { static?: boolean }) => {
      const contact = process.env.BIRDWATCH_CONTACT;
      if (!contact) throw new Error("brand needs BIRDWATCH_CONTACT: site operators see it");
      const sites = o.static ? null : sitesHere(process.env);
      const fetcher = new PoliteFetcher(userAgent(contact));
      console.log(
        JSON.stringify(await brandOf(url, { fetcher, sites: sites ?? undefined }), null, 2),
      );
    });

  common(program.command("sources"))
    .description("the sources this machine can run, from the environment")
    .option("--yt-dlp <cmd>", "the yt-dlp command", process.env.BIRDWATCH_YTDLP ?? "yt-dlp")
    .action(async (o: Common & { ytDlp: string }) => {
      const ledger = ledgerOf(o);
      const sources = sourcesOf(o, ledger);
      const rows = [...sources.values()].map(({ name, kind, cost, from }) => ({
        name,
        kind,
        cost,
        from: from ?? "tool",
      }));
      console.log(JSON.stringify(rows, null, 2));
    });
}
