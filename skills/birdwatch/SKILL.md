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
environment; `weaver sources` lists what this machine can run.

## One run

```sh
weaver plan "<the ask>" [--kind web|video|site|channel|person] [--known "<fact>"...] [--site <host>]
weaver brief <run>                                   # read it after every step
weaver search <run> "<terms>" --why "<why>"          # or a JSON array of {terms, why, site?} on stdin
weaver add call <run> <hit> keep|drop --why "<why>"  # triage, one per hit
weaver open <run> [<hit>...] [--url <url>...] --why "<why>"   # then reads every kept hit without a document
weaver extract <run>                                 # the model behind the quote gate, every document without a verdict
weaver check <run> [-n 3]                            # a sample of findings read against their documents
weaver add finding <run> <document> --text "<sentence>" --quote "<quote on the page>"
weaver add gap <run> "<what is still missing>"
weaver add edge <run> again|stop --why "<why>"       # your review of the round
weaver plan --run <run>                              # after again: the next round
```

Each step command prints `{run, round, step, ok, note, wrote}`; `wrote` is every record it
wrote (a document's text as `chars`). A step that gave up exits 2 with its note: read the note,
fix the cause (no source, no contact, no key), run it again. A step run again skips what its
records show done.

## How to drive

1. **Plan.** Read the ask and `brief`. Write 2 to 4 queries that cover it from different
   sides (a number, a how, a who, a counter-view). Each query's why says what it would prove.
   The budget in `brief` is a guard rail, not a cap: more queries are fine when each has a why.
2. **Triage.** `brief` lists `hits.uncalled` with title and snippet. Call every one: keep what
   can hold a fact that answers the ask, drop the rest (vendor pages, listicles, a page the
   ask does not need). One why per call, short. A page you know of yourself: `open --url`.
3. **Read and extract.** `open`, then `extract`. Read the findings in `wrote`. The gate already
   proved each quote is on its page; you judge whether it answers the ask. Drop a finding that
   does not (`add call <finding> drop --why`). A fact you saw in a document that the extractor
   missed: `add finding` with its exact quote; a quote that is not on the page fails.
4. **Check.** `check` reads a sample against their documents. A finding that fails is dropped
   with its why; put it back with `add call <finding> keep --why` only if you read the page and
   the check is wrong.
5. **Review.** Ask: does what is kept answer the ask? What is missing? Write each hole as a gap.
   Then the edge: `again` with a why that names the hole (the next round's plan reads it), or
   `stop` with a why that says what the run has and what it still lacks.
6. **Report.** From `brief`: the kept findings, each with its quote, URL and date, grouped by
   what they answer; the gaps; the cost line. Nothing in the report that is not a finding.

Stop when the ask is answered or two rounds in a row added nothing that changed the answer.
Say so in the edge's why.

## The person

Their words are theirs: `weaver add steer <run> "<their words>" --human <name>`. A steer is
rendered first in every later prompt and snapshot. Their keep or drop on a hit or finding:
`add call ... --human <name>`. Never put your words in a `--human` record.

When they ask a question mid-run, answer from `brief` (kept findings, gaps, cost); run no step
they did not ask for.

## Records

Every record carries `from` (ai, human, tool), `by` (your id, their name, a source or model
id), its round, and on a decision, a why. `weaver trace <run>` prints them all; `weaver trace
<run> --type finding` one type. `weaver run --resume <run>` hands a run to the runner (raven's
prompts decide instead of you); `brief` reads a run the runner made the same way.
