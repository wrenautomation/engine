---
name: birdwatch
description: Research a question from the open web with weaver's engine, one step per command. Use when the user says "research <topic>", "find out <question>", "what do sources say about <x>", "look into <vertical>", or wants a sourced answer. You plan, triage, review and stop; the engine searches, opens pages, extracts findings behind a quote gate, checks them, and keeps every record. Every finding is a sentence with a quote on a page the run read.
---

# birdwatch

You drive. The engine is a CLI (`weaver`, `@wrenautomation/weaver`) that prints JSON and writes
a ledger. It never decides what to search next, what to read, or when to stop: you do, in your
own head, and you write each decision as a record with a why. The person steers you in chat;
their words reach the ledger through you as `--human` records.

Set `WEAVER_AGENT` to your id (`claude-code`, `codex`, a name) once: every record you write
names it. The ledger folder is `WEAVER_LEDGER` (default `./ledger`). Sources come from the
environment; `weaver sources` lists what this machine can run. A Reddit thread and a Facebook
group post open through their own readers (`reddit`, `facebook`) before the page openers. Reddit
reads signed out, then as the account `WEAVER_ACCOUNTS` names (`reddit=reddit@alt`); the person
picks that account, never you.

## One run

```sh
weaver recall <terms> [--not <run>] [--also <ledger>...]   # what earlier runs found: quote, URL, source date, run
weaver plan "<the ask>" [--kind web|video|site|channel|person] [--known "<fact>"...] [--site <host>]
weaver brief <run>                                   # read it after every step
weaver search <run> < tree.json                      # the round's query tree (below); or "<terms>" --why, or a JSON array
weaver add call <run> <hit> keep|drop --why "<why>"  # triage, one per hit
weaver open <run> [<hit>...] [--url <url>...] --why "<why>"   # then reads every kept hit without a document
weaver open <run> --with <source>                    # an opener `sources` lists but the run's allow-list lacks (a ladder that came later)
weaver show <run> <document> [--head N]              # the page's text: read it yourself
weaver add finding <run> <document> --text "<sentence>" --quote "<quote on the page>"
weaver add check <run> <finding> --ok|--fail --why "<why>"    # your own check; a fail drops it
weaver extract <run>                                 # bulk only: a model behind the quote gate
weaver check <run> [-n 3]                            # bulk only: a model's sample check
weaver add gap <run> "<what is still missing>"
weaver add pattern <run> "<what several findings say together>" --on <finding> <finding>...
weaver add edge <run> again|stop --why "<why>"       # your review of the round
weaver plan --run <run>                              # after again: the next round
weaver learn <kind> [--sources ...] [--rounds N] [--age "..."]   # after a good run, on the person's yes
```

Each step command prints `{run, round, step, ok, note, wrote}`; `wrote` is every record it
wrote (a document's text as `chars`). A step that gave up exits 2 with its note: read the note,
fix the cause (no source, no contact, no key), run it again. A step run again skips what its
records show done.

## How to drive

0. **Recall.** Before the plan, `recall` the ask's words. A recalled finding still fresh for the
   ask (its `date`, else `found`) goes in `--known` with its source; an old one names a query to
   read again. A quote short of 5 words fails the gate: take the line with its label.
1. **Plan the tree.** Read the ask and `brief`. Write the round's query tree: one facet per
   side of the ask the guide names (`brief.planFile` kind's guide: a number, a how, a who, a
   counter-view, a primary source; add a facet the ask needs), each with 2 or 3 tries in the
   order you expect to work: the plain words first, then a narrower angle (a site, a year, a
   synonym the trade uses, a forum, a filing). Each query's why says what it would prove. Show
   the tree to the person before you run it. `search < tree.json` runs one tier: the first
   time, every facet's first try. After you triage, the same command with the same file runs
   the next try of each facet with fewer kept hits than the guide's `thin` (3); a facet at
   `thin` is done, a facet out of tries is a gap, a facet with uncalled hits waits. So the
   tree falls through on what you kept, never on what a searcher returned (a searcher always
   returns a page). `--all` runs every facet's next try at once. `tree` in the output shows
   each try, what it wrote, `kept`, `uncalled`, and which guide facets you did not cover. A
   trade word that sits on both sides of a market ("agency", "coach", "setter") pulls the
   other side: put a buyer marker in the terms ("coaches who hired", not "appointment
   setting"), and read the first tries' titles in `brief` before you write the next. The
   budget is a guard rail, not a cap.

   ```json
   {"facets": [
     {"name": "number", "why": "how often it happens", "tries": [
       [{"terms": "<plain words> rate", "why": "..."}],
       [{"terms": "<plain words> survey 2025", "why": "..."}, {"terms": "...", "site": "reddit.com", "why": "..."}]
     ]},
     {"name": "counter", "why": "who says it fails", "tries": [[{"terms": "...", "why": "..."}]]}
   ]}
   ```
2. **Triage.** `brief` lists `hits.uncalled` with title, snippet and `facets`: the facets whose
   queries found it, most first. A page two facets found is worth a look first. Call every one
   (the tree's next tier waits on it):
   keep what can hold a fact that answers the ask, drop the rest (vendor pages, listicles, a
   page the ask does not need). One why per call, short. A page you know of yourself: `open --url`.
3. **Read.** `open`, then `show` each document and read it. Write each fact that answers the
   ask as `add finding` with its exact quote; a quote that is not on the page fails. Say what
   the page lacks as `add gap --on <document>`. For a run too big to read (tens of pages), or
   in the runner, `extract` puts a model behind the same gate; then judge its findings in
   `wrote` and drop what does not answer the ask (`add call <finding> drop --why`).
4. **Check.** Read a sample of the kept findings again against their documents (`show`), a
   different page each: `add check <finding> --ok|--fail --why`. A fail drops it. For a bulk
   run, `check` does the same with a model; put a finding back with `add call <finding> keep
   --why` only if you read the page and the check is wrong.
5. **Patterns.** When kept findings from different sites say one thing, write it once:
   `add pattern` with the finding ids. The engine counts the distinct sites; one site is a
   claim, not a pattern, and it warns. A pattern is your sentence; the findings are its proof.
6. **Review.** Ask: does what is kept answer the ask? What is missing? Write each hole as a gap.
   Then the edge: `again` with a why that names the hole (the next round's plan reads it), or
   `stop` with a why that says what the run has and what it still lacks. The budget's rounds
   are a guard rail: past them, say in the why why one more round is worth it.
7. **Report.** From `brief`: the patterns first, each with its site count and its findings;
   then the kept findings no pattern rests on, each with its quote, URL and date; the gaps; the
   cost line. Nothing in the report that is not a finding.
8. **Learn.** If the run was good and the person agrees, `weaver learn <kind>` with what it
   taught: a source order that yielded, a budget that fit, an age sentence, a `--thin` that
   fits the kind, a facet the guide should name (`--tree <file>`). The next run of that kind
   starts there. Never change a prompt without showing the person the diff.

Stop when the ask is answered or two rounds in a row added nothing that changed the answer.
Say so in the edge's why.

## The person

Their words are theirs: `weaver add steer <run> "<their words>" --human <name>`. A steer is
rendered first in every later prompt and snapshot. Their keep or drop on a hit or finding:
`add call ... --human <name>`; their gap, `add gap ... --human <name>`; a step they want rerun,
`add edge <run> back --to <step> --why "<their why>" --human <name>`. Never put your words in a `--human` record.

When they ask a question mid-run, answer from `brief` (kept findings, gaps, cost); run no step
they did not ask for.

## Records

Every record carries `from` (ai, human, tool), `by` (your id, their name, a source or model
id), its round, and on a decision, a why. `weaver trace <run>` prints them all; `weaver trace
<run> --type finding` one type. `weaver run --resume <run>` hands a run to the runner (raven's
prompts decide instead of you); `brief` reads a run the runner made the same way.
