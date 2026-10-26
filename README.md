# scribe

Pages, files and videos in. Text and quoted facts out. No database, no
accounts, no business rules: a library that reads, and a small CLI over it.

Four doors:

| Import | Does |
|---|---|
| `@wrenautomation/scribe/fetch` | `PoliteFetcher` (declared User-Agent, per-host throttle, retries, never re-downloads a file on disk), robots.txt, `readPage` (HTML to title, text, links, mailtos, tels), `fetchLadder` (asks a fetch ladder for a blocked page through an injected client) |
| `@wrenautomation/scribe/text` | `htmlText`, `pdfText`, `decodeHtml` |
| `@wrenautomation/scribe/video` | `watch`: ffmpeg cuts and frames, Cohere speech and on-screen text, Gemini's read of the screen when a key works; shot labels |
| `@wrenautomation/scribe/study` | a study whose every claim quotes a page: query planning, the claim gate, which pages to read, drafts that cite claims, the markdown report |

Everything is a pure function of what you pass: bytes, a URL, a video path, keys, a client.
What searches, stores, schedules or knows a customer belongs to the caller.

## CLI

Needs Node 24+. `watch` needs ffmpeg, and `yt-dlp` for a URL.

```sh
npm i @wrenautomation/scribe
npx scribe fetch https://example.com --contact you@example.com   # a page as text
npx scribe text report.pdf                                        # a PDF as text
COHERE_API_KEY=... npx scribe watch talk.mp4                      # speech, on-screen text, cuts
```

## Library

```ts
import { PoliteFetcher, readPage, userAgent } from "@wrenautomation/scribe/fetch";
import { gateClaims } from "@wrenautomation/scribe/study";

const fetcher = new PoliteFetcher(userAgent("you@example.com"), { minInterval: 2 });
const res = await fetcher.get("https://example.com/report");
const page = readPage(res.text, res.url);
// Ask a model for claims about the page, then keep only the ones whose quote is on it.
const { kept, dropped } = gateClaims(proposals, { url: res.url, text: page.text }, angles.length);
```

## Develop

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm test
```

A `v*` tag publishes to npm (`.github/workflows/release.yml`) with the `NPM_TOKEN` secret; trusted publishing replaces the token once the package's trusted publisher is set on npm.

License: PolyForm Shield 1.0.0 (`LICENSE.md`).
