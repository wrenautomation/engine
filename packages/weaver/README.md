# weaver

The web in. Documents out. No database, no accounts, no business rules: a
library that fetches, and a small CLI over it. Carved out of
[falcon](https://github.com/wrenautomation/falcon) (then `@wrenautomation/scribe`)
in 2026-10: everything that takes a URL or spawns yt-dlp lives here, everything
that reads a file, bytes or text stays there.

Two doors:

| Import | Does |
|---|---|
| `@wrenautomation/weaver/fetch` | `PoliteFetcher` (one request at a time per host, a contact in the User-Agent, retries on 429 and 5xx, a byte cap), `robots` in warn mode, `fetchLadder` (plain GET up to a browser through a `LadderClient`) |
| `@wrenautomation/weaver/video` | `readYoutube` (captions and chapters by yt-dlp, plus a video model's read of the screen in clips), `readYoutubeByUrl` (the video model alone, no download), `readVideo` (any other video: yt-dlp, then falcon's `watch`), `readAudio` (a podcast by its audio URL, then falcon's `hearAudio`), `watch` over a URL or a file, `flatPlaylist` (what a profile, channel or search holds), `download` |

Every reader returns falcon's one `VideoRead` shape. What turns a page or a file into text is
falcon's (`@wrenautomation/falcon`).

Three more doors run the research engine (wren's `designs/2026-10-26-research-engine.md`):

| Import | Does |
|---|---|
| `@wrenautomation/weaver/engine` | `Source` (a name, `search` and/or `open`, a cost), `registry` and the plan's allow-list, `run(deps, options)`: plan, fetch, triage, read, extract, check (a sample of findings against their documents), review, round after round until raven's edge says stop; `fold` rebuilds a run's state from its records, so a run resumes from the step it stopped on; `Transient`, the failure worth another try; raven's `Model`, `Ask`, `PlanFile` and record shapes re-exported, so a host pins weaver alone |
| `@wrenautomation/weaver/sources` | `searxng`, `exa` (search), `youtube` (search and read, yt-dlp), `fetcher` (open, the polite fetcher), `ladder` (open, autobrowse's fetch ladder up to a browser), `paste` (a person's URLs), `ledger` (hits earlier runs saw) |
| `@wrenautomation/weaver/ledger` | the records (`query`, `hit`, `document`, `finding`, `verdict`, `call`, `spend`, `snapshot`, `edge`, `done`, `steer`, `gap`, `check`), `FilesLedger` (a folder: `runs/<run>/<writer>.jsonl`, `plans/<kind>.json`), `MemoryLedger`, yield rows per source, person, channel and kind |

Every record carries `from` (ai, human or tool) and `by` (a model id, a source, a person). A
person's pasted URL, a person's keep or drop, are the same records as the model's. The plan
file in `plans/<kind>.json` beside the ledger (prompts, sources, budget) is where a run learns:
copy raven's default (`npx raven plans web`), tune it, keep it there.

## CLI

Needs Node 24+. `read` needs yt-dlp and ffmpeg.

```sh
npm i @wrenautomation/weaver
npx weaver fetch https://example.com/report --contact you@example.com   # a page as text
GEMINI_API_KEY=... npx weaver read https://www.youtube.com/watch?v=...    # captions + screen
COHERE_API_KEY=... npx weaver read https://www.instagram.com/reel/...     # watched: speech, screen, cuts
npx weaver list 'ytsearch10:cold email' --to 10                           # hits as JSON, no downloads
```

The engine's commands print JSON, so Claude Code can drive them. The model is `anthropic` by
default (Claude Haiku direct, `ANTHROPIC_API_KEY`; `--model anthropic:sonnet|opus|id` for another),
`--model gateway[:alias]` for Wren's LLM gateway (`WREN_LLM_GATEWAY_URL`,
`WREN_LLM_GATEWAY_TOKEN`), or any command that reads a prompt on stdin and prints the answer
(`claude -p --output-format json` is Claude Code headless). Sources come from the environment:
`SEARXNG_URL` (and `SEARXNG_TOKEN`, a bearer, for an instance behind a proxy), `EXA_API_KEY`
(or `_1..n`), `GEMINI_API_KEY` for videos without
captions, `WEAVER_CONTACT` for the fetcher (no contact, no page opens), `AUTOBROWSE_URL` and
`AUTOBROWSE_TOKEN` for the ladder. The ledger folder is `--ledger` or `WEAVER_LEDGER`
(default `./ledger`); `--writer` or `WEAVER_WRITER` names your file in it.

Every model call is a `spend` record with the model id, the tokens in and out, and `usd` from
the list price (`src/app/prices.ts`: Claude Haiku, Sonnet and Opus 5.5; the gateway's `free`
alias is $0; another model keeps its tokens, no price). `run` prints the run's total on stderr
and as `cost` in its JSON.

```sh
WEAVER_CONTACT=you@example.com npx weaver run "how do staffing firms win repeat clients" --known "referrals convert"
npx weaver run "..." --kind video --propose "cold email teardown" --by will   # your queries, merged with the model's
npx weaver run "..." --url https://a.example/report https://b.example/post    # pages you want read, first
npx weaver run --resume 01M5YS... --url https://a.example/report             # from the step it stopped on; same --url, same --model
npx weaver run "..." --pause                                                   # stop after each round's review
npx weaver steer 01M5YS... "numbers only; skip vendor pages"                   # what you say, first in every prompt after
npx weaver run --resume 01M5YS... --pause                                      # the next round, steered
npx weaver gap 01M5YS... "no UK numbers yet"                                   # what the run lacks: its review and next plan read it
npx weaver back 01M5YS... fetch -r "searxng was down"                          # rerun one step of the round; then --resume
npx weaver trace 01M5YS... --type finding spend                                # the run's records, JSON lines
npx weaver drop 01M5YT... -r "the quote is a forecast, not a result"           # a call in your name
npx weaver yield --source exa                                                  # hits, reads, proposed, kept
npx weaver sources                                                             # what this machine can run
```

`run` exits 2 when the run stopped on a step that gave up (no model, no source, a block):
`--resume` continues it once the cause is fixed. A failure worth another try (a 429, a 5xx, a
dropped connection) is tried three times with a pause, every attempt a `spend` record; a step
that still cannot go on writes no `done`, and `run` waits and resumes it, five times at most,
before it exits 2. Searches, reads and extracts fan out (four reads or extracts at a time);
each document's records land as its batch settles, and a step run again skips what its records
show done. An extract that fails for good (the model's answer would not parse, a 400) stops the
step with its findings so far on record and `run` exits 2: `--resume` asks only for the
documents without a verdict. A model answer the output cap cut is not a failure: the whole
findings before the cut go through the gate and the model is asked again for the rest of the
document, with those findings known (falcon's `Cut`; the `spend` carries both calls' tokens).

`--pause` stops the run after a review that says `again`, with no exit code: between rounds
you (or a Claude Code session) read the trace, `keep` or `drop` findings, and `steer` the run
with free text. Every `steer` record is rendered first in every prompt of the rounds after it,
under "The person says:". `--resume` goes on.

The steps talk in English records. A query every searcher answered with no new hit, and a kept
hit no source could open, each write a `gap`; so does `weaver gap`. The round's review reads
the gaps; the next round's plan reads them, and the review's why on `again`, under "The last
round left open". `weaver back` writes a person's edge: the fold takes it like raven's.

The check step reads a sample of the round's kept findings (`budget.checks`, 3 by default;
spread across documents) against the text around each quote. The extract gate proves a quote is
on the page; the check asks whether it backs the sentence. A finding that fails gets a `check`
record and a drop call; `weaver keep` puts it back. The review sees every check, and a finding
carries its document's date, so the review weighs age as the plan file's `age` line says.

## Library

```ts
import { PoliteFetcher, userAgent } from "@wrenautomation/weaver/fetch";
import { readPage } from "@wrenautomation/falcon/text";

const fetcher = new PoliteFetcher(userAgent("you@example.com"));
const res = await fetcher.get(url);
const page = readPage(res.text, res.url);
```

The engine, with your own model and sources:

```ts
import { claimExtractor } from "@wrenautomation/falcon/document";
import { registry, run } from "@wrenautomation/weaver/engine";
import { FilesLedger, ulids } from "@wrenautomation/weaver/ledger";
import { exa, fetcherSource } from "@wrenautomation/weaver/sources";

const ledger = new FilesLedger("./ledger", "will");
const sources = registry(exa({ keys }), fetcherSource({ fetcher }));
const result = await run(
  { sources, ledger, model, extractor: claimExtractor, clock: () => new Date(), ids: ulids(), runner: "will" },
  { ask: { text: "how do staffing firms win repeat clients", kind: "web", known: [] }, planFile },
);
result.state.findings; // each with its proof: a quote on a page the run read
```

`RunOptions.steps` bounds one call (64 by default): a loop that advances a run a little per pass
passes a few and calls again with `resume`. A host with its own ledger, sources or model mounts
the same commands: `addEngineCommands(program, { ledger, sources, model, extractor })` from
`@wrenautomation/weaver` (wren's `research` command is these over Postgres).

## Develop

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm test
```

A `v*` tag publishes to npm (`.github/workflows/release.yml`, trusted publishing: no stored token).

License: PolyForm Shield 1.0.0 (`LICENSE.md`).
