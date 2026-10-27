# falcon

Files, markup and media in. Text and quoted facts out. No database, no
accounts, no business rules: a library that reads, and a small CLI over it.
Was `@wrenautomation/scribe` until 0.3.0, when fetching moved to
[weaver](https://github.com/wrenautomation/weaver) and the rest took this name.

Three doors:

| Import | Does |
|---|---|
| `@wrenautomation/falcon/text` | `htmlText`, `pdfText`, `decodeHtml`; `readPage` (HTML to title, text, links, mailtos, tels) |
| `@wrenautomation/falcon/video` | `watch` a video file: ffmpeg cuts and frames, Cohere speech and on-screen text, Gemini's read of the screen when a key works; shot labels. `captionsBody` renders a caption track per chapter, `hearAudio` transcribes an audio file by clips; both feed the one `VideoRead` shape weaver's readers return |
| `@wrenautomation/falcon/study` | a study whose every claim quotes a page: query planning, the claim gate, which pages to read, drafts that cite claims, the markdown report |

Everything is a pure function of what you pass: bytes, text, a file path, keys.
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
import { gateClaims } from "@wrenautomation/falcon/study";

const page = readPage(html, url);
// Ask a model for claims about the page, then keep only the ones whose quote is on it.
const { kept, dropped } = gateClaims(proposals, { url, text: page.text }, angles.length);
```

## Develop

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm test
```

A `v*` tag publishes to npm (`.github/workflows/release.yml`, trusted publishing: no stored token).

License: PolyForm Shield 1.0.0 (`LICENSE.md`).
