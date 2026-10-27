# raven

Ask in, plan out. The planner of Wren's research engine, on its own: no database, no
sources, no model of its own. Pure functions and prompts; a plan file per ask kind; the model
is injected. Depends on nothing of Wren's: [weaver](https://github.com/wrenautomation/weaver)
runs the plans raven writes, [falcon](https://github.com/wrenautomation/falcon) reads what
weaver fetched.

Three calls, one record each:

| Call | In | Out |
|---|---|---|
| `plan` | an ask (text, kind, what is known), proposals from people or other models, yield rows from earlier runs | a `Plan`: typed queries, each with `why`, `from` (ai or human) and `by` (model id, plan file or person), the sources it may use, the budget, and a snapshot of what raven was given |
| `triage` | hits as a source shows them for free (title, channel, length, date, snippet, which sources returned it) | read or skip per hit, with why; the read budget caps it |
| `review` | what a round came to (counts, found lines, notes) | the edge: `stop`, `again` (a new round from plan) or `back` (rerun one step), with why |

Ask kinds: `web`, `video`, `channel`, `person`, `site`. Each has a default plan file
(prompts, sources, budget). Copy one, tune it, keep it beside your ledger: that is where a run
learns. Raven never loops; the runner takes the edge.

## CLI

Needs Node 24+. The model is a command that reads the prompt on stdin and prints the answer.
Default `claude -p`, so Claude Code is the model in any terminal; `RAVEN_MODEL` or `--model`
changes it; `--no-model` plans from your own queries only.

```sh
npm i @wrenautomation/raven
npx raven plan "how do staffing firms win repeat clients" --known "referrals convert"
npx raven plan "..." --kind video --propose "cold email teardown" --by will      # yours merge with the model's
npx raven triage --plan plan.json --hits hits.json
npx raven review --round round.json
npx raven plans web > plans/web.json                                             # copy, then tune
```

## Library

```ts
import { plan, triage, review, type Model } from "@wrenautomation/raven";

const model: Model = { id: "claude-sonnet-5-5", ask: (prompt, shape) => yourClient.json(prompt, shape) };
const p = await plan({ ask: { text, kind: "web", known }, model, proposals: [byHand] });
const reads = await triage(hits, p, model);
const edge = await review(round, model);
```

Every record carries `from` and `by`. A person's query, a person's read-or-skip, a person's
edge are the same shapes with `from: "human"`: the engine shows them in the same rows as the
model's.

## License

PolyForm Shield 1.0.0. Free to use, change and share; not to build a competing product.
