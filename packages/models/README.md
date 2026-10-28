# models

One door to every model call in Wren's repos. A `Model` takes text, image, video, audio and PDF
parts. It answers with text, tokens, USD and why it stopped. `ask` parses the answer to a zod
shape and asks again once when the answer does not fit.

The rule: code that calls a model calls it through this package. A new vendor, a new part kind or
a new price goes here, never in the caller. No guard enforces this; this file and wren's
`designs/2026-10-26-research-engine.md` record it.

| Import | Does | Runs in |
|---|---|---|
| `@wrenautomation/models` | `Model`, `Part`, `Usage`; `anthropic`, `gemini`, `cohere`, `compatible` (Groq, OpenRouter, Mistral, Cerebras, OpenAI), `gateway`; `rotating` key rings, `fallback` model order, `geminiLiveKeys`; `fakeModel`, `scriptedModel`; the errors | Node, Workers |
| `@wrenautomation/models/hear` | speech to text: `groqEar`, `cohereEar`, `compatibleEar` (any `/audio/transcriptions` server) | Node, Workers |
| `@wrenautomation/models/prices` | one price table: `MODEL_PRICES`, `SPEECH_PRICES`, `priceUsd`, `priced`, `speechUsd`, `addUsage`, `pricesText` | Node, Workers |
| `@wrenautomation/models/command` | a shell command as a model (`commandModel`), Claude Code on the subscription (`claudeCode`) | Node |
| `@wrenautomation/models/spec` | a model from a setting string: `modelFromSpec("anthropic:sonnet", env)` | Node |

## Use

```ts
import { anthropic, fallback, gemini } from "@wrenautomation/models";
import { z } from "zod";

const claude = anthropic({ key: [key1, key2], model: "sonnet" });
const { value, usage } = await claude.ask("Name three colours.", z.object({ colours: z.array(z.string()) }));
// usage: { input, output, cacheRead?, cacheWrite?, usd }

const eyes = gemini({ key: geminiKeys });
const reply = await eyes.complete({
  prompt: [
    { type: "text", text: "What is on this slide?" },
    { type: "image", data: pngBytes, mediaType: "image/png" },
  ],
  effort: "low",
});

// A stretch of a YouTube video, sampled at one frame per 2 s, at low resolution.
const clip = await eyes.complete({
  prompt: [
    { type: "video", data: new URL(youtubeUrl), mediaType: "video/mp4", clip: { startS: 60, endS: 90, fps: 0.5 } },
    { type: "text", text: "What is said and shown?" },
  ],
  resolution: "low",
});

// Newest model first; each call starts at the top and moves down past a busy or refused one.
const reader = fallback([gemini({ key, model: "gemini-3.8-flash" }), gemini({ key })], { passes: 4 });
```

Gemini reads a clipped video through its Interactions API (the generateContent route has no clip
field in the SDK), with `store: false`. Every other request goes to generateContent.

Spec strings: `fake`, `claude-code[:model]`, `anthropic[:haiku|sonnet|opus|id]`, `gateway[:alias]`,
`gemini[:id]`, `cohere[:id]`, `groq|openrouter|mistral|cerebras|openai[:id]`, `command:<shell command>`.
Keys come from `<VENDOR>_API_KEY`, or a ring `NUM_<VENDOR>` + `<VENDOR>_API_KEY_1..n`.

## Errors

Each error says what the caller does next. Each check (`isTransient`, `isCut`...) also matches by
name, so a host that holds two copies of this package still sorts them.

| Error | When | Next |
|---|---|---|
| `Transient` | 408, 429, 5xx, a dropped connection, a timeout | wait `retryAfter`, try again |
| `Refused` | 401, 402, 403 | the key ring moves to the next key |
| `InputRejected` | 400, 413, 422 | change the request |
| `Unsupported` | a part kind the model does not take | pick another model; parts are never dropped |
| `Cut` | the output cap stopped the answer | `partial` holds the text so far, `usage` its cost |
| `Filtered` | the vendor stopped the answer itself (Gemini's `RECITATION`, `SAFETY`, a failed run) | `stop` says which; ask in other words |
| `NoAnswer` | `ask` found no object of the shape after its repairs | `issues` says why |

A key ring moves past a refused or busy key at once, and passes over a refused key on later calls. When every key is busy, it waits 2 s, then
doubles up to 30 s, for `passes` passes (default 1). Retries inside the SDK are off. An error never carries the key: a vendor that echoes it (Gemini
does, on a suspended key) has it put out as `[key]`.

## Prices

USD per million tokens, as of `PRICES_AS_OF`. A call on a free key ring (Cohere, Gemini, Groq,
OpenRouter `:free`, the gateway's `free`, Claude Code on the subscription) records `usd: 0`,
`free: true`, and `listUsd` (what it would have cost). Anthropic cache writes are 1.25x input
(5 minutes) or 2x (1 hour); reads are 0.1x (0.05x on Opus 5.5). Haiku 5.5 has two tiers: a
prompt over 100K tokens costs 5x. A model with no row keeps its tokens and has no `usd`.

Sources: Anthropic's pricing page; Cohere from activepieces.com and pricepertoken.com; Groq from
groq.com/pricing; Gemini from anotherwrapper.com and benchlm.ai.

## Why the AI SDK

The adapters sit on the [AI SDK](https://ai-sdk.dev) 7 (Apache 2.0): one call shape for Anthropic,
Google, Cohere and every OpenAI-compatible server, with media parts and token details per vendor.
The other choices were each vendor's own SDK (four call shapes and four usage formats to keep) and
plain `fetch` (every wire format kept by hand). This package adds only what the SDK leaves out:
errors sorted by what to do next, key rings, prices, the zod parse with repair, and speech.

## Develop

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm test
```

A `v*` tag publishes to npm (`.github/workflows/release.yml`, trusted publishing: no stored token).

License: PolyForm Shield 1.0.0 (`LICENSE.md`).
