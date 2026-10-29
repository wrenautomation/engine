# birdwatch

Research from the open web, driven by an agent one step per command. The agent plans, triages,
reviews and stops; birdwatch searches, opens pages, extracts findings behind a quote gate, checks
them, and keeps every record in a ledger. Every finding is a sentence with a quote on a page the
run read. `skills/birdwatch/SKILL.md` (in this repo) is how an agent drives it.

Reading the web and files (the fetch ladder, HTML and PDF to text, video) is
[`@wrenautomation/read`](https://github.com/wrenautomation/engine/tree/main/packages/read)'s. Every model call goes through
[`@wrenautomation/models`](https://github.com/wrenautomation/engine/tree/main/packages/models). Until 0.29.0 this was three packages: raven (a model planner, gone at 0.30.0: the
agent plans), falcon (`./document`) and weaver (the engine, sources, ledger and CLI).

| Import | Does |
|---|---|
| `@wrenautomation/birdwatch/engine` | `Source` (a name, `search` and/or `open`, a cost), `registry` and the plan's allow-list; the agent's calls (`planRound`, `search`, `open`, `extract`, `check`, `add`, `accept`, `brief`), one step each; the judge's passes (`judgeHits`, `judgeDocuments`, `judgeFindings`, `judgeStats`); `fold` rebuilds a run's state from its records, so a step run again skips what is done; `Transient`, the failure worth another try; the ask and plan file shapes (`Ask`, `PlanFile`, `Query`, `QueryTree`, `Edge`, `Snapshot`) and a stock plan file per ask kind (`web`, `video`, `channel`, `person`, `site`: sources, budget, `age`, `rules`, the query tree's guide) |
| `@wrenautomation/birdwatch/sources` | `searxng`, `exa` (search), `youtube` (search and read, yt-dlp), `fetcher` (open, the polite fetcher), `ladder` (open, autobrowse's fetch ladder up to a browser), `reddit` and `facebook` (open a thread or a group post through autobrowse's site routes), `google` (Google's own page through the desk's browser: each result a hit, the AI Overview one hit with its text as the snippet, each page it cites a hit), `arxiv` (search and read: the API inside `BIRDWATCH_ARXIV_CATEGORIES`, each hit led by its OpenAlex citation count and comment; the paper read whole from its HTML, else its PDF; one call per 3 s), `paste` (a person's URLs), `ledger` (hits earlier runs saw). A query with a `site` skips a searcher that cannot keep to it (`Source.keeps`: `youtube` keeps to YouTube only). A follow (`Source.follows`, `follow`) lists a page's author's posts (`youtube`: a channel's uploads, from a video or the channel, and a TikTok profile; `reddit`: a user's top posts and comments) or pages like it (`exa`: findSimilar) |
| `@wrenautomation/birdwatch/ledger` | the records (`query`, `hit`, `document`, `finding`, `verdict`, `call`, `spend`, `snapshot`, `edge`, `done`, `steer`, `gap`, `check`, `pattern`, `found`, `judge`, `person`), `FilesLedger` (a folder: `runs/<run>/<writer>.jsonl`, `plans/<kind>.json`), `MemoryLedger`, yield rows per source, person, channel and kind |
| `@wrenautomation/birdwatch/document` | the document side: `Document`, `Finding`, `Proof`, `Verdict` (zod), readers by media (`html`, `pdf`, `text`), `claimExtractor` (findings that quote the document, through the gate, and a verdict on the document: its quality and the ask's gap; no cap on findings or their length, and an answer the model's output cap cut is continued from its last kept quote), the `Model` seam it takes and the `Cut` a model throws when its cap cut an answer |

Every record carries `from` (ai, human or tool) and `by` (an agent or model id, a source, a
person). A person's keep or drop is the same record as the agent's. The plan file in
`plans/<kind>.json` beside the ledger (sources, budget, age, rules, the tree guide) is where a run
learns: `birdwatch learn <kind>` writes its next version from what a run taught, on the person's
agreement; a kind with no tuned file runs the stock one (`birdwatch plans <kind>` prints it).
`brief.guide` shows the kind's age sentence and rules to the agent.

## CLI

Needs Node 24+. `read` and `watch` need yt-dlp and ffmpeg.

```sh
npm i @wrenautomation/birdwatch
npx birdwatch fetch https://example.com/report --contact you@example.com   # a page as text
GEMINI_API_KEY=... npx birdwatch read https://www.youtube.com/watch?v=...    # captions + screen
COHERE_API_KEY=... npx birdwatch read https://www.instagram.com/reel/...     # watched: speech, screen, cuts
npx birdwatch list 'ytsearch10:cold email' --to 10                           # hits as JSON, no downloads
npx birdwatch text report.pdf                                             # a file on disk as text
npx birdwatch page saved.html --url https://example.com/report            # title, text, links as JSON
COHERE_API_KEY=... npx birdwatch watch talk.mp4                           # speech, on-screen text, cuts
npx birdwatch plans web > ledger/plans/web.json                           # a stock plan file, to tune
```

An agent (Claude Code, or any agent with a shell) drives the engine one command at a time: it
plans, triages, reviews and stops in its own head, and the engine does the fixed work (search,
open, extract behind the quote gate, check) and keeps the records. Every command prints JSON.

```sh
export BIRDWATCH_AGENT=claude-code                     # the agent's id on every record it writes
birdwatch plan "how do staffing firms win repeat clients" --known "referrals convert"   # a run; prints its id
birdwatch plan "who buys growth help" --premise "coaches are the buyer"   # a premise gets a tree facet that tests it
birdwatch brief 01M5YS...                              # the ask, budget, sources, what is open, hits, findings, cost
birdwatch recall staffing repeat clients --not 01M5YS... # earlier runs' findings: quote, URL, source date, run; --also <ledger> per extra folder
birdwatch search 01M5YS... "staffing repeat client rate" --why "the ask's words"       # one query, then every searcher
echo '[{"terms":"...","why":"..."},{"terms":"...","why":"..."}]' | birdwatch search 01M5YS...   # a batch
birdwatch search 01M5YS... < tree.json                 # a query tree, one tier: {facets: [{name, why, tries: [[{terms, why}], [...]]}]}
birdwatch search 01M5YS... < tree.json                 # after triage, the same file: the next try of each facet still thin in kept hits
birdwatch add call 01M5YS... 01M5YT... keep --why "a survey with numbers"               # triage: a hit kept
birdwatch add call 01M5YS... 01M5YU... drop --why "a vendor page"
birdwatch open 01M5YS... 01M5YT... --url https://a.example/report --why "numbers"      # keep these, read every kept hit
birdwatch open 01M5YS... --with ladder                                                  # an opener the run lacks joins it, to open only
birdwatch show 01M5YS... 01M5YV...                     # a document's text, for the agent to read itself
birdwatch add finding 01M5YS... 01M5YV... --text "412 firms were surveyed." --quote "A 2025 survey of 412 firms"
birdwatch add check 01M5YS... 01M5YW... --ok --why "the quote says it"   # the agent's own check; --fail also drops
birdwatch extract 01M5YS...                            # or a model behind the quote gate, every document without a verdict
birdwatch check 01M5YS... -n 3                         # or a model's sample of findings read against their documents
birdwatch check 01M5YS... --patterns                   # every unchecked finding a pattern rests on
birdwatch accept 01M5YS... keep --over 0.8 --why "serves the ask"   # the judge's hints in bulk, at the agent's bar
birdwatch accept 01M5YS... class --min 0.8 --why "head of page"   # also: drop --under 0.2
birdwatch add gap 01M5YS... "no UK numbers yet"
birdwatch add steer 01M5YS... "numbers only" --human will                                # the person's word, relayed
birdwatch add pattern 01M5YS... "Repeat clients come from referrals." --on 01M5YV... 01M5YW...   # what findings say together; sites counted
birdwatch add edge 01M5YS... again --why "thin on the UK"                                # the review: a new round
birdwatch plan --run 01M5YS...                         # round 2: known, steer and what round 1 left open, in its snapshot
birdwatch plan "coaches: who pays for setters" --parent 01M5YS... --why "the best niche of round 1"   # a child run
birdwatch add dead 01M5YT... spend --why "found consumers, not buyers"   # later tries skip the facet
birdwatch follow 01M5YS... --from 01M5YV... --as posts --why "the speaker's other talks"   # the author's own posts; --as similar: pages like it; a paper: --as refs (what it cites) or citers (what cites it)
birdwatch add person 01M5YS... "Bee Speaker" --profile https://www.youtube.com/@bee --aka Bee --why "one speaker"   # one person across sites
birdwatch learn web --sources searxng exa --rounds 4   # the plan file's next version, after a good run
birdwatch learn web --thin 2                           # the tree's guide: a try under 2 new hits falls through
birdwatch learn web --show                             # the current one
birdwatch add edge 01M5YS... stop --why "enough"
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
`check` put a model behind the same gate instead, for bulk; both paths write the same records.

The person, through the agent or by hand:

```sh
npx birdwatch add steer 01M5YS... "numbers only; skip vendor pages" --human       # what you say: the brief shows it first
npx birdwatch add gap 01M5YS... "no UK numbers yet" --human                       # what the run lacks: the next plan reads it
npx birdwatch add edge 01M5YS... back --to fetch --why "searxng was down" --human # the step to run again
npx birdwatch trace 01M5YS... --type finding spend                                # the run's records, JSON lines
npx birdwatch add call 01M5YS... 01M5YT... drop --why "a forecast, not a result" --human   # a call in your name
npx birdwatch yield --source exa                                                  # hits, reads, proposed, kept
npx birdwatch sources                                                             # what this machine can run
npx birdwatch serve --port 4747                                                   # the ledger over HTTP for a viewer, read only
```

The model is `anthropic` by default (Claude Haiku direct, `ANTHROPIC_API_KEY`; `--model
anthropic:sonnet|opus|id` for another), `--model gateway[:alias]` for Wren's LLM gateway
(`WREN_LLM_GATEWAY_URL`, `WREN_LLM_GATEWAY_TOKEN`), or any command that reads a prompt on stdin
and prints the answer (`claude -p --output-format json` is Claude Code headless). The model does
the bulk (extract, check) only; the agent decides. Sources come
from the environment: `SEARXNG_URL` (and `SEARXNG_TOKEN`, a bearer, for an instance behind a
proxy), `EXA_API_KEY` (or `_1..n`), `GEMINI_API_KEY` for videos without captions,
`BIRDWATCH_CONTACT` for the fetcher and `arxiv` (no contact, no page opens; `OPENALEX_API_KEY`, free, gives `arxiv` its own citation budget, and `SEMANTIC_SCHOLAR_API_KEY`, free, its own rate for `--as refs`; `--sources arxiv` names it, since no stock plan file does), and for the ladder either
`AUTOBROWSE_URL` and `AUTOBROWSE_TOKEN` (a worker's HTTP face) or `RESTATE_INGRESS_URL` and
`RESTATE_AUTH_TOKEN` (the Restate ingress a desk worker sits behind: `POST /desk/call`;
`AUTOBROWSE_SERVICE` for another service name). The same worker gives the `reddit` and
`facebook` readers. `BIRDWATCH_ACCOUNTS` names the account each site reader may sign in as
(`reddit=reddit@alt`); a site with no entry reads signed out only. The ledger folder is `--ledger` or
`BIRDWATCH_LEDGER` (default `./ledger`); `--writer` or `BIRDWATCH_WRITER` names your file in it.
The judge is `--judge` or `BIRDWATCH_JUDGE` (`jev`, `jev:<model>`, `fake`, `off`); with neither,
`jev` when `TYPESAFE_API_KEY` is set, else none. `--no-judge` turns it off for one command.

Each open source claims the URLs it opens (`opens`): `youtube` a YouTube page, `fetcher` and
`ladder` any other http(s) page, `reddit` a Reddit thread or comment permalink, `facebook` a
public group post. A site's own reader (`first`) gets its turn before the general openers,
whatever the allow-list's order: it answers the thread as data, where a fetched page is a wall.
`reddit` reads signed out first (`reddit-public`, the thread's feed); only when that misses and
`BIRDWATCH_ACCOUNTS` names an account does it ask again signed in as it. `facebook` is always
signed out. A spent cap or a refused read is a miss; a busy profile (503) or no answer retries.
A refusal carries the worker's access code in its reason: `need_login`, `platform_blocked`,
`rate_limited` or `upstream_broken`. The last two never read signed in: that fixes neither.
The read step asks before a call, so a source that was never
going to open a hit writes no spend. A page that was fetched with nothing usable (a 403, a block
the ladder's last rung still hit, a media no reader takes, a ladder answer that is not HTML such
as a PDF) is a miss: the source throws, its `spend` says `ok: false` with the reason, the next
opener gets its turn, and a hit every opener missed is a `gap` that lists each reason. A page
that answered 200 and still holds nothing (a captcha wall, a "not found" shell, under 200
characters of text) is the same miss, with the title or the count as the reason. A run's
snapshot pins its sources at `plan`: `sources`, the allow-list, which search, open and follow;
`opens`, the registry's other openers (unless `--sources` was given), which open and follow but
never search. `open --with <source>` writes a new snapshot that adds one to `opens` (the read
note names them when hits missed). The
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
step with its findings so far on record and exits 2: `extract` again asks only for the
documents without a verdict. A model answer the output cap cut is not a failure: the whole
findings before the cut go through the gate and the model is asked again for the rest of the
document, with those findings known (`./document`'s `Cut`; the `spend` carries both calls' tokens).

Between rounds the person reads `brief` (or the agent tells them), keeps or drops findings (`add
call`), and steers the run with free text (`add steer`). Every `steer` record shows first in the
brief and in the extract's prompt of the rounds after it. `budget.rounds` is a guard
rail, not a stop rule: past it, the edge's why says why one more round is worth it.

The steps talk in English records. A query every searcher answered with no new hit, and a kept
hit no source could open (a 403, a block the ladder could not pass), each write a `gap`; so does
`add gap`. The round's review reads the gaps and a person's keep or drop with its why; the next
round's plan reads them, and the review's why on `again`, under "The last round left open".
`add edge back --to <step>` writes a person's edge: the fold takes it like the agent's. A `pattern`
(`add pattern`) is what several kept findings say together, in the agent's words; its count of
distinct sites is computed from the findings' proofs, never claimed, and `brief.patterns` lists
them for the report. A run can be a child (`--parent <run> --why`): its snapshot names the parent, its plan reads
what the parent and siblings found (recall over those runs), and its budget is the parent's at
most. The plan file's `runs.depth` (2) is a guard rail: a deeper child warns. Two caps stop: the
children per parent round (`runs.children`, 6) and the whole tree's reads (`runs.reads`, pinned
on the root's snapshot as `treeReads`; by default the root's reads × rounds × (children + 1)).
`open` stops or cuts its hits at the tree's cap; `brief.lineage` and `brief.treeRoom` show the
ancestors and the room left. A
stopped child's stop, patterns and dead ends (`add dead`) reach the parent's next plan as
known lines; a running child is open. A `class` (`add class`) says what kind of source a document is (primary data, survey,
practitioner, vendor, forum, news, other), with why; its findings take it, and a class on one
finding overrides it. `brief.patterns[].classes` counts sources per class: distinct sites,
but each forum thread on its own; `echo` flags a pattern whose classed sources are all vendors,
and `unchecked` lists its findings no check has read. Only the agent or a person writes a
class. A tree facet's `needs` names the classes that can prove it; `tree.facets[].lacks` says
its read pages have none (and the facet is not `enough`), and a facet whose every try pins one site is flagged. A `draft` (`add draft`, JSON items on stdin) is a rough draft over the kept
findings and patterns: the study's draft gate drops an item that cites nothing kept or has a number
no cited quote has. `brief.draft` shows the latest. It is never the final write.

The check step reads a sample of the round's kept findings (`budget.checks`, 3 by default, or a
tenth of the kept findings, whichever is more; 0 is none; spread across documents);
`check --patterns` reads every unchecked finding a pattern rests on, against the text around each quote. The extract gate proves a quote is
on the page; the check asks whether it backs the sentence. A finding that fails gets a `check`
record and a drop call; `add call <finding> keep` puts it back. A fail comes with a fix when one
fits: a narrower sentence the same quote backs. The fix passes the extract gate and a second
check, then lands as a new finding with `fixes` naming the old one. The review sees every check, and a finding
carries its document's date, so the review weighs age as the plan file's `age` line says.

The judge (Jev, from `@wrenautomation/models/judge`) answers typed questions with probabilities
and no text, so it never writes a call or a check. `search` asks it of each new hit: does it
serve the ask, whose side wrote it (the people the ask is about, or a seller to them), what
class. `open` asks each new page its class. `check` asks each kept finding with a quote: does the
quote back it, does it credit another source. Each answer is a `judge` record and each call a
spend. They hint and route: `brief.hits.uncalled` sorts by facets then the judge's serves, and
shows its answers; `documents.unclassed[].guess` shows its class; a facet with `needs` is not
enough while its kept hits have a class (the agent's, else the judge's) and none is needed;
`patterns[].cites` lists findings that credit another source, and the vendor echo warning names
them. `check` reads the sample plus each finding the judge backs under 0.8: a judge's yes never
takes one out. `accept` turns the hints into records at the agent's own bar, each with the
judge's number in its why. `brief.judge` counts its calls, cost, and how often the agent and the
check agreed with it. A trial (0.22.0): `open` also asks each page its `worth` (would a careful
researcher cite it for the ask). `documents.toExtract[].worth` shows it; `brief.judge.worth`
gives its AUC against "a finding on it was kept", and what a gate at a half would skip. Nothing
gates on it yet.

From 0.25.0 the judge reads a page whole: the body to its references (an appendix stays), in
parts of 64,000 characters, 4 at most, each answer the most yes of any part. Jev's input is
cheap (about $0.04 per million tokens), so a paper costs about a tenth of a cent. A run's
criteria (`--criterion name="question"`, on `plan`) are the person's own yes-or-no tests of a
good source: the judge asks each one on every hit and every page, and the brief shows its odds
on each hit (serves and each test) as a hint. Their mean sorts `hits.uncalled` and `documents.toExtract`; `brief.judge.criteria` gives each one's AUC against
"a finding on it was kept", on hits and on pages. A sort and a hint, never a gate.

From 0.27.0 the extractor reads the body too (the reference list holds no finding). Each review
sees every earlier round's new hits and kept findings, and decides when to stop. A paper's
`follow --as refs` and `--as citers` list what it cites and what cites it. A check (25 papers, Sonnet as reference):
on the whole page, Jev's criteria odds rank Sonnet's yes over its no with AUC 0.94 to 1.00; on the
abstract, 0.77 to 1.00.

A follow is a query record with `follow: {url, as, document?}` and terms `<as> of <url>`. The
fetch step sends it to the sources whose `follows` takes it, `follow` lists up to 30, and the
hits go through triage, the read and the caps like a search's. Each query goes to the allow-list
as it stood when it was written: a source `follow --with` lets in joins `opens`, so it runs
follows, never searches. A
`person` names one author across sites (profile URLs, names they post under); a document is
theirs when a posts follow from their profile found it, when its URL sits under a profile, or
when its channel (or its hit's) is one of their names. `brief.people` counts each person's
documents, kept findings and sites; `brief.unfollowed` lists kept pages no follow started from
and no person owns.

`serve` puts the ledger on 127.0.0.1 for a viewer (the Wren portal's Research page). Read only:
the CLI stays the one writer. `GET /runs` gives a row per run (ask, parent, round, next step,
counts, spend). `GET /runs/:run` gives a `RunView` (`v: 1`): the brief, every query with the hits
it wrote and found again, every hit with its sources, queries, call and judge, every page with its
class, verdict and person, every finding with its checks, the timeline of decisions and step ends
with their whys, and spend per source. `GET /runs/:run/documents/:doc` gives a page's stored text.
`GET /events` sends `event: run` with `{run}` each time a run's files change, and a ping each 25 s;
the viewer then gets that run again. CORS answers `--origin` (the portal by default) and any
localhost, and says yes to Chrome's private-network preflight. The types live in
`src/engine/view.ts`; a host copies them and checks `v`, never imports them.

## Library

```ts
import { PoliteFetcher, userAgent } from "@wrenautomation/read/fetch";
import { readPage } from "@wrenautomation/read/text";

const fetcher = new PoliteFetcher(userAgent("you@example.com"));
const res = await fetcher.get(url);
const page = readPage(res.text, res.url);
```

The engine, with your own model and sources:

```ts
import { claimExtractor } from "@wrenautomation/birdwatch/document";
import { extract, open, planRound, registry, search } from "@wrenautomation/birdwatch/engine";
import { FilesLedger, ulids } from "@wrenautomation/birdwatch/ledger";
import { exa, fetcherSource } from "@wrenautomation/birdwatch/sources";

const ledger = new FilesLedger("./ledger", "will");
const sources = registry(exa({ keys }), fetcherSource({ fetcher }));
const deps = { sources, ledger, model, extractor: claimExtractor, clock: () => new Date(), ids: ulids(), writer: "will" };
const agent = { from: "ai" as const, by: "my-agent" };
const { run } = await planRound(deps, { ask: { text: "how do staffing firms win repeat clients", kind: "web" }, planFile, model: model.id });
await search(deps, run, [{ terms: "staffing repeat client rate", why: "the ask's words" }], agent);
await open(deps, run, { urls: ["https://a.example/report"], why: "a survey" }, agent);
await extract(deps, run); // findings, each with its proof: a quote on a page the run read
```

A host with its own ledger, sources or model mounts
the same commands: `addEngineCommands(program, { ledger, sources, model, extractor })` from
`@wrenautomation/birdwatch` (wren's `research` command is these over Postgres).

## Develop

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm test
```

A `v*` tag publishes to npm (`.github/workflows/release.yml`, trusted publishing: no stored token).

License: PolyForm Strict 1.0.0 (`LICENSE.md`).
