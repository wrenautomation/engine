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
| `@wrenautomation/weaver/engine` | `Source` (a name, `search` and/or `open`, a cost), `registry` and the plan's allow-list; the agent's calls (`planRound`, `search`, `open`, `extract`, `check`, `add`, `brief`), one step each; `run(deps, options)`: plan, fetch, triage, read, extract, check (a sample of findings against their documents), review, round after round until raven's edge says stop; `fold` rebuilds a run's state from its records, so a run resumes from the step it stopped on; `Transient`, the failure worth another try; raven's `Model`, `Ask`, `PlanFile` and record shapes re-exported, so a host pins weaver alone |
| `@wrenautomation/weaver/sources` | `searxng`, `exa` (search), `youtube` (search and read, yt-dlp), `fetcher` (open, the polite fetcher), `ladder` (open, autobrowse's fetch ladder up to a browser), `reddit` and `facebook` (open a thread or a group post through autobrowse's site routes), `paste` (a person's URLs), `ledger` (hits earlier runs saw). A query with a `site` skips a searcher that cannot keep to it (`Source.keeps`: `youtube` keeps to YouTube only) |
| `@wrenautomation/weaver/ledger` | the records (`query`, `hit`, `document`, `finding`, `verdict`, `call`, `spend`, `snapshot`, `edge`, `done`, `steer`, `gap`, `check`, `pattern`, `found`), `FilesLedger` (a folder: `runs/<run>/<writer>.jsonl`, `plans/<kind>.json`), `MemoryLedger`, yield rows per source, person, channel and kind |

Every record carries `from` (ai, human or tool) and `by` (a model id, a source, a person). A
person's pasted URL, a person's keep or drop, are the same records as the model's. The plan
file in `plans/<kind>.json` beside the ledger (prompts, sources, budget) is where a run learns:
`weaver learn <kind>` writes its next version from what a run taught (sources, budget, age, a
prompt), on the person's agreement; a kind with no tuned file runs raven's default.

## CLI

Needs Node 24+. `read` needs yt-dlp and ffmpeg.

```sh
npm i @wrenautomation/weaver
npx weaver fetch https://example.com/report --contact you@example.com   # a page as text
GEMINI_API_KEY=... npx weaver read https://www.youtube.com/watch?v=...    # captions + screen
COHERE_API_KEY=... npx weaver read https://www.instagram.com/reel/...     # watched: speech, screen, cuts
npx weaver list 'ytsearch10:cold email' --to 10                           # hits as JSON, no downloads
```

The engine has two drivers over the same steps. An agent (Claude Code, or any agent with a
shell) drives it one command at a time: it plans, triages, reviews and stops in its own head and
the engine does the fixed work (search, open, extract behind the quote gate, check) and keeps the
records. `run` is the runner: raven's prompts make those decisions and the loop runs alone. Both
write the same ledger, so `run --resume` takes over a run an agent started and `brief` reads a
run the runner made. Every command prints JSON.

```sh
export WEAVER_AGENT=claude-code                     # the agent's id on every record it writes
weaver plan "how do staffing firms win repeat clients" --known "referrals convert"   # a run; prints its id
weaver plan "who buys growth help" --premise "coaches are the buyer"   # a premise gets a tree facet that tests it
weaver brief 01M5YS...                              # the ask, budget, sources, what is open, hits, findings, cost
weaver recall staffing repeat clients --not 01M5YS... # earlier runs' findings: quote, URL, source date, run; --also <ledger> per extra folder
weaver search 01M5YS... "staffing repeat client rate" --why "the ask's words"       # one query, then every searcher
echo '[{"terms":"...","why":"..."},{"terms":"...","why":"..."}]' | weaver search 01M5YS...   # a batch
weaver search 01M5YS... < tree.json                 # a query tree, one tier: {facets: [{name, why, tries: [[{terms, why}], [...]]}]}
weaver search 01M5YS... < tree.json                 # after triage, the same file: the next try of each facet still thin in kept hits
weaver add call 01M5YS... 01M5YT... keep --why "a survey with numbers"               # triage: a hit kept
weaver add call 01M5YS... 01M5YU... drop --why "a vendor page"
weaver open 01M5YS... 01M5YT... --url https://a.example/report --why "numbers"      # keep these, read every kept hit
weaver open 01M5YS... --with ladder                                                  # an opener the run's allow-list lacks joins it
weaver show 01M5YS... 01M5YV...                     # a document's text, for the agent to read itself
weaver add finding 01M5YS... 01M5YV... --text "412 firms were surveyed." --quote "A 2025 survey of 412 firms"
weaver add check 01M5YS... 01M5YW... --ok --why "the quote says it"   # the agent's own check; --fail also drops
weaver extract 01M5YS...                            # or a model behind the quote gate, every document without a verdict
weaver check 01M5YS... -n 3                         # or a model's sample of findings read against their documents
weaver add gap 01M5YS... "no UK numbers yet"
weaver add steer 01M5YS... "numbers only" --human will                                # the person's word, relayed
weaver add pattern 01M5YS... "Repeat clients come from referrals." --on 01M5YV... 01M5YW...   # what findings say together; sites counted
weaver add edge 01M5YS... again --why "thin on the UK"                                # the review: a new round
weaver plan --run 01M5YS...                         # round 2: known, steer and what round 1 left open, in its snapshot
weaver learn web --sources searxng exa --rounds 4   # the plan file's next version, after a good run
weaver learn web --thin 2                           # the tree's guide: a try under 2 new hits falls through
weaver learn web --show                             # the current one
weaver add edge 01M5YS... stop --why "enough"
```

`plan` opens a round: its snapshot carries the ask, what is known (the findings so far), every
steer, what the last round left open, the allow-list and the budget. No queries: the agent's come
through `search` or `add query`, never capped. The budget is a guard rail: `brief` shows it, and
an edge `again` past `budget.rounds` prints a warning, never a refusal. `search`, `open`,
`extract` and `check` each run one step and print what it wrote (a document's text as `chars`);
a step that gave up exits 2 with its note. `open` reads every kept hit of the run that has no
document; `extract` every document without a verdict; `check` a sample across documents of the
kept findings not yet checked. `add` writes one record by hand: a query, a finding (its quote
must be on the document word for word, or the add fails with the gate's why), a check (the
agent's own read of a finding against its document; a fail also drops it), a call (keep or
drop a hit or a finding), an edge (`again`, `stop`, `back --to <step>`), a gap, or a steer (always
the person's: `--human [name]`). Every `add` takes `--why` where a decision needs one. A
`--human` record is the person's word through the agent: `from: human`, `by` their name.

A round's search is a tree when the agent gives one: facets (the sides a researcher covers: a
number, a how, a who, a counter-view, a primary source; the plan file's `tree` guide names them),
each with tries in order, each try a list of queries. `search` runs one tier per call, in one
fetch: the first call, every facet's first try; each call after, the next try of each facet
with fewer kept hits than the guide's `thin` (3 by default). A facet at `thin` is done; a facet
with hits no call has named waits for triage; a facet out of tries and still thin is a gap,
written once. The yield a try falls through on is what triage kept, never what a searcher
returned: every searcher returns a page. `--all` runs every facet's next try, whatever triage
kept. A page a second query brings back is a `found` record on the first hit, never a second
hit, and it counts as kept for every facet that reached it. `brief.hits.uncalled` lists each
hit with the facets that found it, most first; `brief.tree` shows every try with what it wrote,
`kept` and `uncalled` per facet. A guide facet no query served is named in the note.
`learn --thin <n>` or `--tree <file>` tunes the guide.

The agent reads for itself: `show <run> <document>` prints a document's stored text, `add
finding` writes what it read behind the same quote gate, `add check` its own check. `extract` and
`check` put a model behind the same gate instead, for bulk or for the runner; both paths write
the same records.

The runner alone:

```sh
WEAVER_CONTACT=you@example.com npx weaver run "how do staffing firms win repeat clients" --known "referrals convert"
npx weaver run "..." --kind video --propose "cold email teardown" --by will   # your queries, merged with the model's
npx weaver run "..." --url https://a.example/report https://b.example/post    # pages you want read, first
npx weaver run --resume 01M5YS... --url https://a.example/report             # from the step it stopped on; same --url, same --model
npx weaver run "..." --pause                                                   # stop after each round's review
npx weaver add steer 01M5YS... "numbers only; skip vendor pages" --human       # what you say, first in every prompt after
npx weaver run --resume 01M5YS... --pause                                      # the next round, steered
npx weaver add gap 01M5YS... "no UK numbers yet" --human                       # what the run lacks: its review and next plan read it
npx weaver add edge 01M5YS... back --to fetch --why "searxng was down" --human # rerun one step of the round; then --resume
npx weaver trace 01M5YS... --type finding spend                                # the run's records, JSON lines
npx weaver add call 01M5YS... 01M5YT... drop --why "a forecast, not a result" --human   # a call in your name
npx weaver yield --source exa                                                  # hits, reads, proposed, kept
npx weaver sources                                                             # what this machine can run
```

The model is `anthropic` by default (Claude Haiku direct, `ANTHROPIC_API_KEY`; `--model
anthropic:sonnet|opus|id` for another), `--model gateway[:alias]` for Wren's LLM gateway
(`WREN_LLM_GATEWAY_URL`, `WREN_LLM_GATEWAY_TOKEN`), or any command that reads a prompt on stdin
and prints the answer (`claude -p --output-format json` is Claude Code headless). Sources come
from the environment: `SEARXNG_URL` (and `SEARXNG_TOKEN`, a bearer, for an instance behind a
proxy), `EXA_API_KEY` (or `_1..n`), `GEMINI_API_KEY` for videos without captions,
`WEAVER_CONTACT` for the fetcher (no contact, no page opens), and for the ladder either
`AUTOBROWSE_URL` and `AUTOBROWSE_TOKEN` (a worker's HTTP face) or `RESTATE_INGRESS_URL` and
`RESTATE_AUTH_TOKEN` (the Restate ingress a desk worker sits behind: `POST /desk/call`;
`AUTOBROWSE_SERVICE` for another service name). The same worker gives the `reddit` and
`facebook` readers. `WEAVER_ACCOUNTS` names the account each site reader may sign in as
(`reddit=reddit@alt`); a site with no entry reads signed out only. The ledger folder is `--ledger` or
`WEAVER_LEDGER` (default `./ledger`); `--writer` or `WEAVER_WRITER` names your file in it.

Each open source claims the URLs it opens (`opens`): `youtube` a YouTube page, `fetcher` and
`ladder` any other http(s) page, `reddit` a Reddit thread or comment permalink, `facebook` a
public group post. A site's own reader (`first`) gets its turn before the general openers,
whatever the allow-list's order: it answers the thread as data, where a fetched page is a wall.
`reddit` reads signed out first (`reddit-public`, the thread's feed); only when that misses and
`WEAVER_ACCOUNTS` names an account does it ask again signed in as it. `facebook` is always
signed out. A spent cap or a refused read is a miss; a busy profile (503) or no answer retries.
The read step asks before a call, so a source that was never
going to open a hit writes no spend. A page that was fetched with nothing usable (a 403, a block
the ladder's last rung still hit, a media no reader takes, a ladder answer that is not HTML such
as a PDF) is a miss: the source throws, its `spend` says `ok: false` with the reason, the next
opener gets its turn, and a hit every opener missed is a `gap` that lists each reason. A page
that answered 200 and still holds nothing (a captcha wall, a "not found" shell, under 200
characters of text) is the same miss, with the title or the count as the reason. A run's
allow-list pins its openers at `plan`; `open --with <source>` writes a new snapshot that adds
one the registry has (the read note names them when hits missed). The
ladder costs browser time and one of the worker's daily `fetch` bucket per call. Exa's search
asks for one highlight per result (three sentences, billed per result) as the hit's `snippet`.

Every model call is a `spend` record with the model id, the tokens in and out, and `usd` from
the list price (`src/app/prices.ts`: Claude Haiku, Sonnet and Opus 5.5; the gateway's `free`
alias is $0; another model keeps its tokens, no price). `run` prints the run's total on stderr
and as `cost` in its JSON, and the last review's edge (`edge`: next and why) the same way;
`brief` prints the total as `cost`.

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
you (or a Claude Code session) read `brief`, keep or drop findings (`add call`), and steer the
run with free text (`add steer`). Every `steer` record is rendered first in every prompt of the
rounds after it, under "The person says:". `--resume` goes on. A review that says `again` into
a round past `budget.rounds` parks the run the same way (`parked` says so, no exit code): the
budget is a guard rail, not a stop rule. `--resume` goes one more round; `plan --run` opens it
by hand.

The steps talk in English records. A query every searcher answered with no new hit, and a kept
hit no source could open (a 403, a block the ladder could not pass), each write a `gap`; so does
`add gap`. The round's review reads the gaps and a person's keep or drop with its why; the next
round's plan reads them, and the review's why on `again`, under "The last round left open".
`add edge back --to <step>` writes a person's edge: the fold takes it like raven's. A `pattern`
(`add pattern`) is what several kept findings say together, in the agent's words; its count of
distinct sites is computed from the findings' proofs, never claimed, and `brief.patterns` lists
them for the report. A `draft` (`add draft`, JSON items on stdin) is a rough draft over the kept
findings and patterns: falcon's draft gate drops an item that cites nothing kept or has a number
no cited quote has. `brief.draft` shows the latest. It is never the final write.

The check step reads a sample of the round's kept findings (`budget.checks`, 3 by default;
spread across documents) against the text around each quote. The extract gate proves a quote is
on the page; the check asks whether it backs the sentence. A finding that fails gets a `check`
record and a drop call; `add call <finding> keep` puts it back. The review sees every check, and a finding
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

License: PolyForm Strict 1.0.0 (`LICENSE.md`).
