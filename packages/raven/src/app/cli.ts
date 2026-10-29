#!/usr/bin/env node
/**
 * `raven`: the planner from a shell. `plan` turns an ask into queries, `triage` marks hits read
 * or skip, `review` picks the edge after a round, `plans` prints a default plan file to tune.
 * The model is a spec from `@wrenautomation/models` (`claude-code` by default, `anthropic:sonnet`,
 * `gateway`...) or any command that reads the prompt on stdin and prints the answer; RAVEN_MODEL
 * or --model changes it. Everything is JSON on stdout.
 */
import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import type { Model } from "@wrenautomation/models";
import { commandModel } from "@wrenautomation/models/command";
import { modelFromSpec, SPEC_NAMES } from "@wrenautomation/models/spec";
import { Command } from "commander";
import { plan } from "../plan.js";
import { defaultPlanFile, PLAN_KINDS } from "../plans/index.js";
import { withPremises } from "../render.js";
import { review } from "../review.js";
import { triage } from "../triage.js";
import { AskKind, HitView, Plan, PlanFile, type Proposal, Round, YieldRow, z } from "../types.js";

const DEFAULT_MODEL = "claude-code";

const readJson = <T>(path: string, shape: z.ZodType<T>): T =>
  shape.parse(JSON.parse(readFileSync(path, "utf8")));
const print = (x: unknown): void => console.log(JSON.stringify(x, null, 2));
const more = (v: string, prev: string[]): string[] => [...prev, v];
const who = (): string => {
  try {
    return userInfo().username;
  } catch {
    return "human";
  }
};

/** `--no-model` sets `model` to false. */
interface ModelOptions {
  model: string | false;
}
/** A spec name (`claude-code`, `anthropic:sonnet`) goes to models; anything else is a command. */
const modelOf = (o: ModelOptions): Model | null => {
  if (o.model === false) return null;
  const name = o.model.split(":")[0] ?? "";
  return (SPEC_NAMES as readonly string[]).includes(name)
    ? modelFromSpec(o.model)
    : commandModel(o.model);
};
const withModel = (c: Command): Command =>
  c
    .option(
      "--model <spec>",
      "a models spec (claude-code, anthropic:sonnet, gateway) or a command: prompt on stdin, answer on stdout",
      process.env.RAVEN_MODEL ?? DEFAULT_MODEL,
    )
    .option("--no-model", "no model call: only what is given by hand");

const program = new Command().name("raven").description("ask in, plan out");

withModel(
  program
    .command("plan <ask>")
    .description("the queries for one ask, merged from the model's and your own")
    .option("-k, --kind <kind>", `one of ${PLAN_KINDS.join(", ")}`, "web")
    .option("--site <host>", "keep every query on one host (kind site)")
    .option("--known <line>", "a fact already in hand; repeat", more, [] as string[])
    .option(
      "--steer <line>",
      "what you say to the model, rendered first; repeat",
      more,
      [] as string[],
    )
    .option("--propose <terms>", "a query of your own; repeat", more, [] as string[])
    .option("--by <name>", "who proposed the --propose queries", who())
    .option("--plan-file <path>", "a tuned plan file (JSON) instead of the default")
    .option("--yield <path>", "yield rows (JSON array) from earlier runs")
    .option("--sources <names>", "narrow the plan file's sources, comma separated")
    .option("--round <n>", "round number", "1"),
).action(
  async (
    text: string,
    o: ModelOptions & {
      kind: string;
      site?: string;
      known: string[];
      steer: string[];
      propose: string[];
      by: string;
      planFile?: string;
      yield?: string;
      sources?: string;
      round: string;
    },
  ) => {
    const kind = AskKind.parse(o.kind);
    const ask = {
      ...withPremises({ known: o.known, premises: [] }),
      text,
      kind,
      steer: o.steer,
      open: [],
      criteria: [],
      ...(o.site ? { site: o.site } : {}),
    };
    const proposals: Proposal[] = o.propose.length
      ? [
          {
            from: "human",
            by: o.by,
            queries: o.propose.map((terms) => ({
              kind,
              terms,
              why: "proposed by hand",
              ...(o.site ? { site: o.site } : {}),
            })),
          },
        ]
      : [];
    print(
      await plan({
        ask,
        model: modelOf(o),
        proposals,
        round: Number(o.round),
        ...(o.planFile ? { planFile: readJson(o.planFile, PlanFile) } : {}),
        ...(o.yield ? { yieldRows: readJson(o.yield, z.array(YieldRow)) } : {}),
        ...(o.sources ? { sources: o.sources.split(",").map((s) => s.trim()) } : {}),
      }),
    );
  },
);

withModel(
  program
    .command("triage")
    .description("read or skip each hit of a plan, with why")
    .requiredOption("--plan <path>", "the plan (JSON, from `raven plan`)")
    .requiredOption(
      "--hits <path>",
      "hits (JSON array of {url, title?, channel?, length?, date?, snippet?, sources?})",
    )
    .option("--plan-file <path>", "a tuned plan file (JSON) instead of the default")
    .option("--yield <path>", "yield rows (JSON array) from earlier runs"),
).action(
  async (o: ModelOptions & { plan: string; hits: string; planFile?: string; yield?: string }) => {
    const model = modelOf(o);
    if (!model) throw new Error("triage needs a model");
    print(
      await triage(readJson(o.hits, z.array(HitView)), readJson(o.plan, Plan), model, {
        ...(o.planFile ? { planFile: readJson(o.planFile, PlanFile) } : {}),
        ...(o.yield ? { yieldRows: readJson(o.yield, z.array(YieldRow)) } : {}),
      }),
    );
  },
);

withModel(
  program
    .command("review")
    .description("the edge after a round: stop, again or back, with why")
    .requiredOption(
      "--round <path>",
      "the round (JSON: ask, round, budget, hits, reads, proposed, kept, found, notes)",
    )
    .option("--plan-file <path>", "a tuned plan file (JSON) instead of the default"),
).action(async (o: ModelOptions & { round: string; planFile?: string }) => {
  const model = modelOf(o);
  if (!model) throw new Error("review needs a model");
  print(
    await review(readJson(o.round, Round), model, {
      ...(o.planFile ? { planFile: readJson(o.planFile, PlanFile) } : {}),
    }),
  );
});

program
  .command("plans [kind]")
  .description("a default plan file to copy and tune; no kind lists them all")
  .action((kind?: string) => {
    if (kind) print(defaultPlanFile(AskKind.parse(kind)));
    else print(PLAN_KINDS.map((k) => defaultPlanFile(k)));
  });

program.parseAsync(process.argv).catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
