# engine

Wren's research and reading engine: four npm packages in one repo, one version, one `v*` tag.

| Package | Does | Depends on |
|---|---|---|
| [`@wrenautomation/models`](packages/models) | Every model call: Anthropic, Gemini, Cohere, any OpenAI-compatible server, a shell command. Text, image, video, audio and PDF parts in; text, tokens and USD out. Key rings, fallbacks, ears for speech, one price table. | nothing of ours |
| [`@wrenautomation/raven`](packages/raven) | Plans: an ask in, typed queries out (each with `why`, `from`, `by`), plan files per ask kind, read-or-skip on hits, the edge after a round. | models |
| [`@wrenautomation/falcon`](packages/falcon) | Reads bytes: HTML and PDF to text, `watch` over a video file, captions and audio to markdown, the study core, claims that quote a page. | models |
| [`@wrenautomation/weaver`](packages/weaver) | Brings the web in and runs the loop: the polite fetcher, robots, the fetch ladder, video and podcast readers over a URL, the engine's runner, its sources and the ledger. | models, raven, falcon |

A model call goes through models, never a vendor API or SDK in the caller. Weaver depends on
falcon, never the reverse.

## Video

Cohere reads images, not video. `watch` sends frames to an eye (`cohereEye`) and the audio to an
ear (`cohereSpeech`). A model that takes video (`geminiVideo`) reads the whole file too. A YouTube
video goes to Gemini by URL, in 10-minute clips (`clip` on a video part).

## Work here

```sh
pnpm install
pnpm gates          # lint, build, test; holds the checks lock
pnpm release 0.7.1  # bumps every package, tags v0.7.1; the tag publishes
```

PolyForm Strict 1.0.0 ([LICENSE.md](LICENSE.md)). Noncommercial use only; commercial use by license from Wren Automation.
