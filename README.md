# weaver

The web in. Documents out. No database, no accounts, no business rules: a
library that fetches, and a small CLI over it. Carved out of
[falcon](https://github.com/wrenautomation/falcon) (then `@wrenautomation/scribe`)
in 2026-10: everything that takes a URL or spawns yt-dlp lives here, everything
that reads a file, bytes or text stays there.

Two doors:

| Import | Does |
|---|---|
| `@wrenautomation/weaver/fetch` | `PoliteFetcher` (one request at a time per host, a contact in the User-Agent, retries on 429 and 5xx, a byte cap), `robots` in warn mode, `fetchLadder` (plain GET up to a browser through a `LadderClient`) |
| `@wrenautomation/weaver/video` | `readYoutube` (captions and chapters by yt-dlp, plus Gemini's read of the screen), `readYoutubeByUrl` (Gemini alone, no download), `readVideo` (any other video: yt-dlp, then falcon's `watch`), `readAudio` (a podcast by its audio URL, then falcon's `hearAudio`), `watch` over a URL or a file, `flatPlaylist` (what a profile, channel or search holds), `download` |

Every reader returns falcon's one `VideoRead` shape. What turns a page or a file into text is
falcon's (`@wrenautomation/falcon`). What searches by a source interface, runs a plan and keeps
the ledger comes next (phase 3.5c of wren's research engine design).

## CLI

Needs Node 24+. `read` needs yt-dlp and ffmpeg.

```sh
npm i @wrenautomation/weaver
npx weaver fetch https://example.com/report --contact you@example.com   # a page as text
GEMINI_API_KEY=... npx weaver read https://www.youtube.com/watch?v=...    # captions + screen
COHERE_API_KEY=... npx weaver read https://www.instagram.com/reel/...     # watched: speech, screen, cuts
npx weaver list 'ytsearch10:cold email' --to 10                           # hits as JSON, no downloads
```

## Library

```ts
import { PoliteFetcher, userAgent } from "@wrenautomation/weaver/fetch";
import { readPage } from "@wrenautomation/falcon/text";

const fetcher = new PoliteFetcher(userAgent("you@example.com"));
const res = await fetcher.get(url);
const page = readPage(res.text, res.url);
```

## Develop

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm test
```

A `v*` tag publishes to npm (`.github/workflows/release.yml`, trusted publishing: no stored token).

License: PolyForm Shield 1.0.0 (`LICENSE.md`).
