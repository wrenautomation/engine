---
name: birdwatch
description: Research a question from the open web with birdwatch, one step per command. Use when the user says "research <topic>", "find out <question>", "what do sources say about <x>", "look into <vertical>", or wants a sourced answer. You plan, triage, review and stop; the engine searches, opens pages, extracts findings behind a quote gate, checks them, and keeps every record. Every finding is a sentence with a quote on a page the run read.
---

# birdwatch

You drive. The engine is a CLI (`birdwatch`, `@wrenautomation/birdwatch`) that prints JSON and
writes a ledger. In the engine repo it is `node packages/birdwatch/dist/app/cli.js`; elsewhere
`npx @wrenautomation/birdwatch`. It never decides what to search next, what to read, or when to stop: you do, in your
own head, and you write each decision as a record with a why. The person steers you in chat;
their words reach the ledger through you as `--human` records.

Set `BIRDWATCH_AGENT` to your id (`claude-code`, `codex`, a name) once: every record you write
names it. The ledger folder is `BIRDWATCH_LEDGER` (default `./ledger`). Sources come from the
environment; `birdwatch sources` lists what this machine can run. A Reddit thread and a Facebook
group post open through their own readers (`reddit`, `facebook`) before the page openers. Reddit
reads signed out, then as the account `BIRDWATCH_ACCOUNTS` names (`reddit=reddit@alt`); the person
picks that account, never you. `google` searches Google's own page through the desk's browser:
each result is a hit, and the AI Overview is one hit (channel "Google AI Overview") whose
snippet holds its text. The Overview is a claim, never a proof: do not open it; keep and read
the pages it cites, which come as hits of their own.

A judge (Jev) answers cheap typed questions on every hit, page and finding: probabilities, no
text. It is a hint and a router, never a decision: you call, class and check; it ranks, guesses
and sends doubted findings to the check. It runs when `TYPESAFE_API_KEY` is set (`--judge`,
`BIRDWATCH_JUDGE`; `--no-judge` for one command). `brief.judge` says what it cost and how often
you and the check agreed with it: a low agreement means read its hints less.

## One run

```sh
birdwatch recall <terms> [--not <run>] [--also <ledger>...]   # what earlier runs found: quote, URL, source date, run, who wrote it
birdwatch plan "<the ask>" [--kind web|video|site|channel|person] [--known "<fact> (<url>)"...] [--premise "<given>"...] [--site <host>]
birdwatch brief <run>                                   # read it after every step
birdwatch search <run> < tree.json                      # the round's query tree (below); or "<terms>" --why, or a JSON array
birdwatch add call <run> <hit> keep|drop --why "<why>"  # triage, one per hit; the last call wins, a flip warns, a person's call stands over yours
birdwatch open <run> [<hit>...] [--url <url>...] --why "<why>"   # then reads every kept hit without a document
birdwatch open <run> --with <source>                    # an opener `sources` lists but the run lacks (a ladder that came later); it joins to open, never to search
birdwatch show <run> <document> [--head N]              # the page's text: read it yourself
birdwatch add finding <run> <document> --text "<sentence>" --quote "<quote on the page>"
birdwatch add check <run> <finding> --ok|--fail --why "<why>"    # your own check; a fail drops it
birdwatch extract <run>                                 # bulk only: a model behind the quote gate
birdwatch check <run> [-n N] [--patterns]               # bulk only: a model's check; --patterns: every finding a pattern rests on
birdwatch add gap <run> "<what is still missing>"
birdwatch add class <run> <document|finding> <class> --why "<why>"   # primary_data, survey, practitioner, vendor, forum, news, other
birdwatch accept <run> keep --over P | drop --under P | class --min P --why "<why>"   # the judge's hints in bulk, at your bar
birdwatch add pattern <run> "<what several findings say together>" --on <finding> <finding>...
birdwatch add edge <run> again|stop --why "<why>"       # your review of the round
echo '[{"title":"..","body":"..","cites":["<pattern or finding>"]}]' | birdwatch add draft <run> --for "<a decision memo>"   # a rough draft, gated
birdwatch plan --run <run>                              # after again: the next round
birdwatch plan "<one niche>" --parent <run> --why "<why this child>"   # a child run: it reads what the tree found
birdwatch add dead <run> <facet> --why "<why>"          # give up on a facet; later tries skip it
birdwatch follow <run> [<url>] --as posts|similar|refs|citers [--from <document>] --why "<why>" [--with <source>...]   # a good page's author's posts, or pages like it
birdwatch add person <run> "<name>" [--profile <url>...] [--aka <name>...] --why "<why>"   # one person across sites
birdwatch learn <kind> [--sources ...] [--rounds N] [--age "..."]   # after a good run, on the person's yes
```

Each step command prints `{run, round, step, ok, note, wrote}`; `wrote` is every record it
wrote (a document's text as `chars`). A step that gave up exits 2 with its note: read the note,
fix the cause (no source, no contact, no key), run it again. A step run again skips what its
records show done.

## How to drive

0. **Recall.** Before the plan, `recall` the ask's words. A recalled finding still fresh for the
   ask (its `date`, else `found`) goes in `--known` with its URL; an old one names a query to
   read again. A quote short of 5 words fails the gate: take the line with its label.
1. **Name the premises.** Before the plan, say what the ask takes as given: a buyer, an offer, a
   price, a channel, a niche. Pass each as `--premise`. A `--known` line without a URL or ledger
   id becomes a premise too. The guide then names a `premise` facet: one try per premise that
   would show it wrong. `tree.uncovered` lists it until a query serves it. A premise that fails
   changes the ask: tell the person.
2. **Plan the tree.** Read the ask and `brief`. Write the round's query tree: one facet per
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
   setting"), and read the first tries' titles in `brief` before you write the next. Each
   facet's why names the buyer it looks for and the inverse to avoid: "owners who pay for
   setters, not consumers who hire a coach"; "firms that buy cold email, not vendors who sell
   it". A facet that still returns the inverse after its tries: `add dead` with the why. The
   budget is a guard rail, not a cap.

   A facet names the source classes that can prove it in `needs`: a spend or price claim
   needs `survey` or `primary_data`, not a forum. Its tries then go where those live, not
   only to new words: public price pages, job ads for the role the buyer would replace (the
   wage), an ad library, a trade association's survey, a filing. Never pin every try of a
   facet to one site: the search says so, and the facet ends with one class. `tree.facets[]`
   shows `classes` (read pages with a kept finding) and `lacks` (none of its `needs`).

   ```json
   {"facets": [
     {"name": "number", "why": "how often it happens", "tries": [
       [{"terms": "<plain words> rate", "why": "..."}],
       [{"terms": "<plain words> survey 2025", "why": "..."}, {"terms": "...", "site": "reddit.com", "why": "..."}]
     ]},
     {"name": "counter", "why": "who says it fails", "tries": [[{"terms": "...", "why": "..."}]]},
     {"name": "spend", "why": "what the buyer pays", "needs": ["survey", "primary_data"], "tries": [[{"terms": "...", "why": "..."}]]}
   ]}
   ```
3. **Triage.** `brief` lists `hits.uncalled` with title, snippet and `facets`: the facets whose
   queries found it, most first, then the judge's `serves`. `judge` shows its answers: `serves`
   (yes), `side` (subject, seller, other) and `class`. A page two facets found is worth a look
   first. A `side` of seller on a buyer facet is the inverse the facet's why names. Call every
   one (the tree's next tier waits on it):
   keep what can hold a fact that answers the ask, drop the rest (vendor pages, listicles, a
   page the ask does not need). One why per call, short. A page you know of yourself: `open --url`.
   Tens of hits: read the top and the bottom of the judge's order, then set a bar from what you
   saw: `accept drop --under 0.2 --why`, and keep only the tops you read. `serves` ranks
   vendor pages high and buyer threads in the middle (0.3 to 0.5): a high keep bar keeps the
   wrong side. Call the middle yourself. Your bar, your why: the records are yours.
4. **Read.** `open`, then `show` each document and read it. Write each fact that answers the
   ask as `add finding` with its exact quote; a quote that is not on the page fails. Say what
   the page lacks as `add gap --on <document>`. For a run too big to read (tens of pages), or
   in the runner, `extract` puts a model behind the same gate; then judge its findings in
   `wrote` and drop what does not answer the ask (`add call <finding> drop --why`). Class each
   page with a kept finding (`brief.documents.unclassed`): `add class <document> <class> --why`.
   Its findings take the class. When one finding differs (a vendor page that quotes a survey),
   class that finding too. `unclassed[].guess` is the judge's class; spot-check a few, then
   `accept class --min 0.8 --why` (a guess at 0.8 or more held in 8 of 8 on one run; under it,
   5 of 7 changed). A facet's `enough` counts the judge's class guess: kept hits that are all
   the wrong class keep the facet's next try open, and `search` says "none of them <needs>".
   After the read, a facet whose classed pages lack its `needs` (`lacks`) is never enough.
   **Follow.** Signals cluster in people. After a page that gave kept findings, do what a person
   does: `follow --from <document> --as posts` lists its author's own posts (a YouTube channel's
   uploads from a video or a channel, a TikTok profile, a Reddit user's top posts and comments);
   `--as similar` lists pages like it (Exa, off the page's own site). After a good paper,
   `--as refs` lists what it cites and `--as citers` what cites it, most cited first (arxiv:
   Semantic Scholar and OpenAlex; a hit is the arXiv page when there is one). The hits come back to
   triage like a search's, under the same caps. `brief.unfollowed` lists the kept pages no
   follow started from and no person owns, most kept findings first. When one author is good,
   find their other places (the channel's about links, a Substack, an X account, a blog): search
   or read, then `add person "<name>" --profile <url>... --aka <channel name>... --why`, and
   follow each profile. `brief.people` counts the documents, kept findings and sites per person.
   A follow no source in the run can do fails and names one that can: add it with `--with`.
   `documents.toExtract[].worth` is a trial: the judge's guess that a careful researcher would
   cite the page. Never skip a page on it. `brief.judge.worth` measures it (AUC against "a
   finding on it was kept", and what a gate at a half would skip).
5. **Check.** Read a sample of the kept findings again against their documents (`show`), a
   different page each: `add check <finding> --ok|--fail --why`. A fail drops it. For a bulk
   run, `check` does the same with a model over the budget's `checks` or a tenth of the kept
   findings, whichever is more, plus each finding the judge doubts. A fail's narrower
   sentence on the same quote comes back as a new finding with `fixes` once a second check
   backs it. Put a finding back with `add call <finding> keep --why` only if you read the page
   and the check is wrong.
6. **Patterns.** When kept findings from different sites say one thing, write it once:
   `add pattern` with the finding ids. The engine counts the distinct sites; one site is a
   claim, not a pattern, and it warns. A pattern is your sentence; the findings are its proof.
   `brief.patterns[].classes` counts its sources per class: a site, but each forum thread on
   its own. Three vendor pages are weaker than one survey: weigh the classes, not the total.
   `echo` says every classed source is a vendor: vendors cite each other, so find the source
   they cite or call it a claim. `cites` lists the findings the judge says credit another
   source: search for that source by name. Every finding a pattern rests on gets checked: `check
   --patterns` (bulk) or your own `add check`; `brief.patterns[].unchecked` lists the rest.
7. **Review.** Ask: does what is kept answer the ask? What is missing? Write each hole as a gap.
   Then the edge: `again` with a why that names the hole (the next round's plan reads it), or
   `stop` with a why that says what the run has and what it still lacks. The budget's rounds
   are a guard rail: past them, say in the why why one more round is worth it. A facet still
   thin after its tries, or one that searches the wrong buyer: `add dead <facet> --why`.
8. **Children.** A wide ask (which niche, which offer) goes deep in child runs, one per option
   worth it: `plan "<the option's ask>" --parent <run> --why "<why this one>"`. The child's plan
   reads what the parent and its siblings found; its budget is never more than the parent's.
   The plan file's `runs.depth` (2: the root and its children) is a guard rail: a deeper child
   warns, and its why says why it beats a sibling. A facet to try again needs no run: add a try
   to `tree.json`, or `add edge again` and plan the next round. Two caps stop: the children per
   round, and the whole tree's reads (`runs.reads` on the root's plan file; by default the
   root's reads times its rounds times children plus one). `open` stops or cuts its hits at the
   tree's cap. `brief.lineage` lists the ancestors, root first, with their asks and whys;
   `brief.treeRoom` says the cap, what the tree read and what is left. Drive each child to its
   stop. Then `add edge again` on the parent: its next plan reads each stopped
   child's stop, patterns (with sites per class) and dead ends, and lists a child still going
   as open. The parent decides: drop an option, add one, or stop. `brief.children` shows the
   tree; `brief.treeCost` what all of it cost.
9. **Report.** From `brief`: the patterns first, each with its site count per class and its findings;
   then the kept findings no pattern rests on, each with its quote, URL and date; the gaps; the
   cost line. Nothing in the report that is not a finding. When the person wants prose (a memo,
   an SOP outline), write a rough draft with `add draft`: each item cites kept patterns or
   findings, and each number comes from a cited quote, or the gate drops the item. A draft is
   never final: the person writes the SOP or the decision.
10. **Learn.** If the run was good and the person agrees, `birdwatch learn <kind>` with what it
   taught: a source order that yielded, a budget that fit, an age sentence, a `--thin` that
   fits the kind, a facet the guide should name (`--tree <file>`). The next run of that kind
   starts there. Never change a prompt without showing the person the diff.

Stop when the ask is answered or two rounds in a row added nothing that changed the answer.
Say so in the edge's why.

## The person

Their words are theirs: `birdwatch add steer <run> "<their words>" --human <name>`. A steer is
rendered first in every later prompt and snapshot. Their keep or drop on a hit or finding:
`add call ... --human <name>`; their gap, `add gap ... --human <name>`; a step they want rerun,
`add edge <run> back --to <step> --why "<their why>" --human <name>`. Never put your words in a `--human` record.

When they ask a question mid-run, answer from `brief` (kept findings, gaps, cost); run no step
they did not ask for.

## Records

Every record carries `from` (ai, human, tool), `by` (your id, their name, a source or model
id), its round, and on a decision, a why. `birdwatch trace <run>` prints them all;
`birdwatch trace <run> --type finding` one type. `birdwatch run --resume <run>` hands a run to the
runner (the planner's prompts decide instead of you); `brief` reads a run the runner made the same way.

To let a person watch or check a run, start `birdwatch serve` (same `--ledger`) in the background
and tell them to open the portal's Research page on this Mac. It updates live as you write.
Stop it when they are done.
