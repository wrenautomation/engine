# engine

Wren's research engine and the map engine: four npm packages in one repo, one version, one `v*` tag.

| Package | Does | Depends on |
|---|---|---|
| [`@wrenautomation/models`](packages/models) | Every model call: Anthropic, Gemini, Cohere, any OpenAI-compatible server, a shell command. Text, image, video, audio and PDF parts in; text, tokens and USD out. Key rings, fallbacks, ears for speech, one price table. | nothing of ours |
| [`@wrenautomation/read`](packages/read) | The web and files in, text out: the polite fetcher, robots, the fetch ladder, HTML and PDF to text, a video or podcast from a URL or a file (`watch`, captions, audio to markdown), the study core. | models |
| [`@wrenautomation/birdwatch`](packages/birdwatch) | Research, driven by an agent one step per command: the planner's shapes and plan files, the document side and claim extractor, the sources, the runner, the ledger, and the one CLI (`birdwatch`). | models, read |
| [`@wrenautomation/orrery`](packages/orrery) | The logic of a map you fold: the fold tree, nested layout over a layout engine you pass, the glide between frames. No renderer. | nothing of ours |

A model call goes through models, never a vendor API or SDK in the caller. birdwatch depends on
read, never the reverse. Until 0.29.0 the research side was raven, falcon and weaver: wren's
`designs/2026-10-26-research-engine.md`, 10-29, has why.

## Video

Cohere reads images, not video. `watch` sends frames to an eye (`cohereEye`) and the audio to an
ear (`cohereSpeech`). A model that takes video (`geminiVideo`) reads the whole file too. A YouTube
video goes to Gemini by URL, in 10-minute clips (`clip` on a video part).

## Drive it

`skills/birdwatch/SKILL.md` is how an agent (Claude Code, Codex, any agent with a shell) runs a
research ask over birdwatch's commands: it plans, triages, reviews and stops; the engine searches,
reads, extracts behind the quote gate, checks, and keeps the ledger. `.claude/skills/birdwatch`
links to it, so a Claude Code session in this repo has `/birdwatch`.

## Work here

```sh
pnpm install
pnpm gates          # lint, build, test; holds the checks lock
pnpm release 0.7.1  # bumps every package, tags v0.7.1; the tag publishes
```

PolyForm Strict 1.0.0 ([LICENSE.md](LICENSE.md)). Noncommercial use only; commercial use by license from Wren Automation.
