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
names it. The ledger folder is `--ledger` (before or after the command) or `BIRDWATCH_LEDGER`
(default `./ledger`). Sources come from the environment. `~/.config/birdwatch/config.json`
names the env files to read keys from, so no wrapper is needed; a set variable wins.
`birdwatch sources` lists what this machine can run. A Reddit thread and a Facebook
group post open through their own readers (`reddit`, `facebook`) before the page openers. A query pinned to `reddit.com` also searches Reddit itself, signed out (it shares a daily read cap; Exa has no Reddit index). `hn` searches Hacker News (free) and reads a thread with every comment. `youtube` lists through the YouTube Data API when `YOUTUBE_API_KEY` is set (exact views, likes and comments; 10k units a day, a search costs 100, a listing 1), else through yt-dlp. A YouTube open reads the captions only, free. `youtube-see` (with `ANTHROPIC_API_KEY`) reads what a video shows, only when you name it: `open --see`. A query pinned to `linkedin.com` searches LinkedIn posts through the desk, only as the account `BIRDWATCH_ACCOUNTS` names (`linkedin=linkedin@wren`; never the bare `linkedin`, a person's own profile). **Presets** set a search's sort and window in one grammar: `latest` or `top`, `day`, `week`, `month` or `year`, or paired (`top-week`). Set `preset` on a query or leaf (`--preset` on the CLI). A preset query goes only to sources that take presets; when none in the run does, the write fails and names them. `linkedin` takes latest, top, day, week, month and pairs (no year). `google` takes day, week, month and year (no sort). `youtube` (Data API only) and `reddit` take all of them. The open-web searchers take none. No preset: each platform's default. For content asks ("what draws now"), use `top-month` or `top-week`. A hit's `metrics` (views, likes, comments) are what the listing showed: a post's draw, before any read. The brief reads each hit's `lift` against its author's median over every run (`authors`): 54.7 is 54.7 times the author's usual, so a small account and a big one compare. `follow --as posts` on an author fills their baseline (five posts up). Reddit
reads signed out, then as the account `BIRDWATCH_ACCOUNTS` names (`reddit=reddit@alt`); the person
picks that account, never you. `google` searches Google's own page through the desk's browser:
each result is a hit, and the AI Overview is one hit (channel "Google AI Overview") whose
snippet holds its text. The Overview is a claim, never a proof: do not open it; keep and read
the pages it cites, which come as hits of their own.

A judge (Jev) answers cheap typed questions on every hit, page and finding: probabilities, no
text. It labels and routes, never judges quality (William, 11-03): it says what a page is
(`format`, `side`, `class`, the ask's criteria) and sends doubted findings to the check. You
read every hit and call each one; nothing is dropped on a judge's number. It runs when `TYPESAFE_API_KEY` is set (`--judge`,
`BIRDWATCH_JUDGE`; `--no-judge` for one command). `brief.judge` says what it cost and how often
you and the check agreed with it: a low agreement means read its hints less.

## One run

```sh
birdwatch recall <terms> [--not <run>] [--also <ledger>...]   # what earlier runs found: quote, URL, source date, run, who wrote it
birdwatch plan "<the ask>" [--kind web|video|site|channel|person] [--known "<fact> (<url>)"...] [--premise "<given>"...] [--site <host>] [--reads N]   # --reads: a wide root's whole-tree read cap
birdwatch brief <run>                                   # the index, after every step; a field with no value is left out (read it with .get)
birdwatch brief <run> --part <name> [--round N|all] [--from I]   # one part whole, 100 rows a page; `parts` in the index names each
birdwatch search <run> < tree.json                      # the round's query tree (below); or "<terms>" --why [--preset top-week], or a JSON array
birdwatch add call <run> <hit> keep|drop --why "<why>"  # triage, one per hit; the last call wins, a flip warns, a person's call stands over yours
echo '[{"on":"<hit>","verdict":"keep","why":".."}]' | birdwatch add call <run>   # many calls, one process
birdwatch open <run> [<hit>...] [--url <url>...] --why "<why>"   # reads the named; no names: every kept hit without a document
birdwatch open <run> <hit>... --see --why "<why>"         # what a video shows, frame by frame: a video whose captions lean on the screen
birdwatch open <run> --lines <file|-> --human           # a person's pasted finds, a URL and its why a line: a kept hit each under its own why, read with no search
birdwatch open --ask "<the ask>" --lines <file|-> --human   # the same paste as a new run; prints the run id
birdwatch open <run> --with <source>                    # an opener `sources` lists but the run lacks (a ladder that came later); it joins to open, never to search
birdwatch show <run> <document> [--head N]              # the page's text: read it yourself
birdwatch add finding <run> <document> --text "<sentence>" --quote "<quote on the page>"
birdwatch add check <run> <finding> --ok|--fail --why "<why>"    # your own check; a fail drops it
birdwatch extract <run> [--limit N]                     # bulk only: a model behind the quote gate; --limit: N pages a call; a line per page on stderr
birdwatch check <run> [-n N] [--patterns]               # bulk only: a model's check; --patterns: every finding a pattern rests on
birdwatch add gap <run> "<what is still missing>"
birdwatch add class <run> <document|finding> <class> --why "<why>"   # primary_data, survey, practitioner, vendor, forum, news, other
birdwatch accept <run> class --min P --why "<why>"   # the judge's class guesses in bulk, at your bar
birdwatch add pattern <run> "<what several findings say together>" --on <finding> <finding>...   # findings of this run or its children
birdwatch add edge <run> again|stop --why "<why>"       # your review of the round
echo '[{"title":"..","body":"..","cites":["<pattern or finding>"]}]' | birdwatch add draft <run> --for "<a decision memo>"   # a rough draft, gated
birdwatch plan --run <run>                              # after again: the next round
birdwatch plan "<one niche>" --parent <run> --why "<why this child>"   # a child run: it reads what the tree found
birdwatch add dead <run> <facet> --why "<why>"          # give up on a facet; later tries skip it
birdwatch add cap <root> <reads> --why "<why>" --human  # the person raises the tree's read cap; never you alone
birdwatch follow <run> [<url>] --as posts|similar|refs|citers [--from <document>] --why "<why>" [--with <source>...]   # a good page's author's posts, or pages like it
birdwatch add person <run> "<name>" [--profile <url>...] [--aka <name>...] --why "<why>"   # one person across sites
birdwatch learn <kind> [--sources ...] [--rounds N] [--age "..."]   # after a good run, on the person's yes
```

Each step command prints `{run, round, step, ok, note, wrote}`; `wrote` is every record it
wrote (a document's text as `chars`). A step that gave up exits 2 with its note: read the note,
fix the cause (no source, no contact, no key), run it again. A step run again skips what its
records show done.

## How to drive

0. **Recall.** Before the plan, `recall` the ask's words (after it, `brief.recalled` carries the
   same for the ask's text). A recalled finding still fresh for the
   ask (its `date`, else `found`) goes in `--known` with its URL; an old one names a query to
   read again. A quote short of 5 words fails the gate: take the line with its label.
1. **Name the premises.** Before the plan, say what the ask takes as given: a buyer, an offer, a
   price, a channel, a niche. Pass each as `--premise`. A `--known` line without a URL or ledger
   id becomes a premise too. The guide then names a `premise` facet: one try per premise that
   would show it wrong. `tree.uncovered` lists it until a query serves it. A premise that fails
   changes the ask: tell the person.
2. **Plan the tree.** Read the ask and `brief`. `brief.guide` holds the kind's age sentence and
   rules: heed them when you plan and when you triage. `brief.sourcesMissing` names allow-listed
   sources this machine cannot run (they search nothing); `brief.sourcesUnused` the ones it can
   that the run has not (not in `sources`, not let in as `opens`). Write the round's query tree: one facet per
   side of the ask the guide names (`birdwatch plans <kind>`: a number, a how, a who, a
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
3. **Triage.** `brief` lists the first 15 of `hits.uncalled` (`--part uncalled` for all) with title, snippet, `metrics` (what the post
   drew, as its site counts it), `lift` (each count over the author's median in `--part authors`,
   every run: 4.5 is 4.5 times their usual, the read for a format that worked) and `facets`: the
   facets whose queries found it, most first, then the ask's criteria. `judge` shows its labels:
   `format` (video, post, thread, article, paper, list, sales_page, directory, docs, other),
   `side` (subject, seller, other) and `class`. A page two facets found is worth a look
   first. A `side` of seller on a buyer facet is the inverse the facet's why names. Call every
   one (the tree's next tier waits on it):
   keep what can hold a fact that answers the ask, drop the rest (vendor pages, listicles, a
   page the ask does not need). One why per call, short. A page you know of yourself: `open --url`.
   Read every hit yourself, however many: the labels sort them, they never call one. There is
   no bulk keep or drop. A drop on a rule (under 3 times the author's usual) names the rule.
   On an ask about content (what draws, what works, a format, a hook), drop only what is off
   the topic. A video that drew little is the comparison that shows what the strong ones did
   differently: keep it, and say so in the why. Open every kept video: its words cost nothing (captions; after a caption 429, Cohere hears the audio).
4. **Read.** `open`, then `show` each document and read it. A video that failed to read
   stays kept and unread: `open <run> <hit> --why` retries that one alone. **See a video** (`open <run> <hit>
   --see --why`) when both hold: it answers the ask, and its captions lean on the screen
   ("as you can see", "this slide", "look at this", a demo or chart the words do not describe)
   or leave the point unsaid. Captions first, frames only where the words fall short; no cap a
   run. It downloads the video, and Claude reads each frame: the text, then what it shows
   (~$0.30 for 10 minutes). The why names what the captions miss. The read is a second document on the hit. Write each fact that answers the
   ask as `add finding` with its exact quote; a quote that is not on the page fails. Say what
   the page lacks as `add gap --on <document>`. For a run too big to read (tens of pages),
   `extract` puts a model behind the same gate; then judge its findings in
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
   **Channel survey** (skim a channel as a person does; YouTube on the Data API): `follow <run>
   <channel> --as posts -n 200 --since 2025-01-01 --why` lists up to 1000 uploads, newest first,
   back to `--since` (2 units per 50). `--q "<words>"` lists only the channel's uploads that match
   (100 units per 50). `brief.surveys` ranks each survey by views over the channel's median
   (`lift`; `channels` gives the median and the posts behind it), the first 20, with `length` to
   tell a short from a long video. The outliers are the formats that win for that channel. Read
   the top K with `open <run> --survey <query> --top 5 --why`, or name the hits you pick.
   `documents.toExtract[]` carries the judge's `format` and the criteria; the order is a sort,
   never a skip.
5. **Check.** Read a sample of the kept findings again against their documents (`show`), a
   different page each: `add check <finding> --ok|--fail --why`. A fail drops it. For a bulk
   run, `check` does the same with a model over the budget's `checks` or a tenth of the kept
   findings, whichever is more, plus each finding the judge doubts. A fail's narrower
   sentence on the same quote comes back as a new finding with `fixes` once a second check
   backs it. Put a finding back with `add call <finding> keep --why` only if you read the page
   and the check is wrong.
6. **Patterns.** When kept findings from different sites say one thing, write it once:
   `add pattern` with the finding ids, from this run or its children. The engine counts the distinct sites; one site is a
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
   `brief.treeRoom` says the cap, what the tree read and what is left. Out of room: ask the
   person; on their yes, `add cap <root> <reads> --why --human`. Drive each child to its
   stop. Then `add edge again` on the parent: its next plan reads each stopped
   child's stop, patterns (with sites per class) and dead ends, and lists a child still going
   as open. The parent decides: drop an option, add one, or stop. `brief.children` shows the
   tree; `brief.treeCost` what all of it cost.
9. **Report.** From `brief` and `brief --part findings --round all`: the patterns first, each with its site count per class and its findings;
   then the kept findings no pattern rests on, each with its quote, URL and date; the gaps; the
   cost line. Nothing in the report that is not a finding. When the person wants prose (a memo,
   an SOP outline), write a rough draft with `add draft`: each item cites kept patterns or
   findings, and each number comes from a cited quote, or the gate drops the item. A draft is
   never final: the person writes the SOP or the decision.
10. **Learn.** If the run was good and the person agrees, `birdwatch learn <kind>` with what it
   taught: a source order that yielded, a budget that fit, an age sentence, a rule for the
   kind (`--rule`, every line), a `--thin` that fits the kind, a facet the guide should name
   (`--tree <file>`). The next run of that kind starts there. Never change a rule without
   showing the person the diff.

Stop when the ask is answered or two rounds in a row added nothing that changed the answer.
Say so in the edge's why.

## Context

`brief <run>` is an index of one size however long the run, as skills load. It holds the small
fields whole, the first 15 rows of each long list, and `parts`: each part's name, what it holds,
its size and its read command. Read a part only when a step needs it: `findings` to review (this
round by default), `checks` before you keep a pattern, a list past its first 15. Earlier rounds
show as `rounds`: each one's edge, patterns and finding count. Their findings stay in the part
(`--round <n>` or `all`).

A new run starts in a fresh session. Go on with a stopped run in its own chat when you can: that
chat holds what the person said about the run. To go on, `add edge <run> again --why`, then
`plan --run <run>`. In a fresh chat, start from `brief <run>`: the ledger holds every record. When
the chat grows long, compact it: the brief gives back any record the summary drops. A new angle on
a past run is a child run (`plan --parent`), not more rounds.

## The person

Their words are theirs: `birdwatch add steer <run> "<their words>" --human <name>`. A steer is
shown first in every later brief and snapshot. Their keep or drop on a hit or finding:
`add call ... --human <name>`; their gap, `add gap ... --human <name>`; a step they want rerun,
`add edge <run> back --to <step> --why "<their why>" --human <name>`. Never put your words in a `--human` record.

When they ask a question mid-run, answer from `brief` (kept findings, gaps, cost); run no step
they did not ask for.

**Their finds.** When they paste sources (videos, posts, sites, each with their why), save the
lines as they wrote them and run `open <run> --lines <file> --human <name>`, or
`open --ask "<their ask>" --lines <file> --human <name>` for a new run. Each line is a kept
hit under their why, read at once; no search round comes first. A line with no why takes
`--why`, their words only. How far to go is theirs to say. With no scope said, or "just read
it" or "watch it and do nothing more": read the pasted sources only, write their findings, then
`add edge stop` with a why that says they asked for these sources only. No search, no follow,
no pattern. Do not widen on your own judgment. `recall` finds those findings in later runs. A
pasted find becomes a seed only when they ask for more ("his channel, his services, his sites,
his themes"): widen the same run with `follow --from <document> --as posts`, a channel survey,
`open --url` on the sites the page links, and a query tree on what is left. One find or fifty,
the steps after the read are the same.

## Records

Every record carries `from` (ai, human, tool), `by` (your id, their name, a source or model
id), its round, and on a decision, a why. `birdwatch trace <run>` prints them all;
`birdwatch trace <run> --type finding` one type. A run from before 0.30.0 that the old runner
made reads the same way in `brief`.

Each step that writes to a run, and `brief`, prints `::view research.run {"run":"<id>"}` on
stderr. A chat that draws cards shows the run's card from that line: keep stderr on.

To let a person watch or check a run, start `birdwatch serve` (same `--ledger`) in the background
and tell them to open the portal's Research page on this Mac. It updates live as you write.
Stop it when they are done.
