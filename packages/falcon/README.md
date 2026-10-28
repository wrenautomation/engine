# falcon

Files, markup and media in. Text and quoted facts out. No database, no
accounts, no business rules: a library that reads, and a small CLI over it.
Was `@wrenautomation/scribe` until 0.3.0, when fetching moved to
[weaver](https://github.com/wrenautomation/weaver) and the rest took this name.

Three doors:

| Import | Does |
|---|---|
| `@wrenautomation/falcon/text` | `htmlText`, `pdfText`, `decodeHtml`; `readPage` (HTML to title, text, links, mailtos, tels) |
| `@wrenautomation/falcon/video` | `watch` a video file: ffmpeg cuts and frames, an ear for the speech (`cohereSpeech`), an eye for the frames (`cohereEye`), and a video model's read of the whole file when given (`geminiVideo`, or `geminiReader` with no key check, for a proxy that holds the keys); shot labels. Every model call goes through `@wrenautomation/models`. `captionsBody` renders a caption track per chapter, `hearAudio` transcribes an audio file by clips; both feed the one `VideoRead` shape weaver's readers return |
| `@wrenautomation/falcon/study` | a study's synthesis reader: the quote gate (`pageQuoted`, `numbersQuoted`), the passages a page is shown by, drafts that cite claims, the markdown report. The planner (queries per angle, which pages to read, the claim gate per angle) went in 0.5.0: raven plans, weaver runs |
| `@wrenautomation/falcon/document` | the research engine's document side: `Document`, `Finding`, `Proof`, `Verdict` (zod), readers by media (`html`, `pdf`, `text`; add `video`, `audio`), `claimExtractor` (findings that quote the document, through the gate, and a verdict on the document: its quality and the ask's gap; no cap on findings or their length, and an answer the model's output cap cut is continued from its last kept quote), the `Model` seam it takes and the `Cut` a model throws when its cap cut an answer |

Everything is a pure function of what you pass: bytes, text, a file path, models.
What fetches a page or a video is weaver's (`@wrenautomation/weaver`: polite HTTP, robots, the
fetch ladder, yt-dlp). What searches, stores, schedules or knows a customer belongs to the caller.

## CLI

Needs Node 24+. `watch` needs ffmpeg.

```sh
npm i @wrenautomation/falcon
npx falcon text report.pdf                                        # a PDF as text
npx falcon page saved.html --url https://example.com/report       # title, text, links as JSON
COHERE_API_KEY=... npx falcon watch talk.mp4                      # speech, on-screen text, cuts
```

## Library

```ts
import { htmlText, readPage } from "@wrenautomation/falcon/text";
import { claimExtractor } from "@wrenautomation/falcon/document";

const page = readPage(html, url);
// The model proposes findings; only the ones whose quote is on the page come back, with a
// verdict: how much of the ask the page served, and what the ask still lacks. `steer` is what
// the person said along the way: it goes first in the prompt. A model whose output cap cut
// the answer throws `Cut` with the text so far; the extractor keeps the whole findings and
// asks again for the rest of the page after the last quote kept (`continued` counts those).
const { findings, dropped, verdict, continued } = await claimExtractor.extract(
  { url, media: "html", text: page.text },
  { text: ask, known, steer: ["numbers only"] },
  model,
);
```

## Develop

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm test
```

A `v*` tag publishes to npm (`.github/workflows/release.yml`, trusted publishing: no stored token).

License: PolyForm Strict 1.0.0 (`LICENSE.md`).
