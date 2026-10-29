# read

The web and files in, text out. No database, no accounts, no business rules: a library that
fetches and reads. Until 0.29.0 this was falcon (files, markup, media) and the fetch and video
halves of weaver; the research engine on top is [`@wrenautomation/birdwatch`](../birdwatch),
whose `birdwatch` CLI carries these readers (`fetch`, `read`, `list`, `text`, `page`, `watch`).

| Import | Does |
|---|---|
| `@wrenautomation/read/fetch` | `PoliteFetcher` (one request at a time per host, a contact in the User-Agent, retries on 429 and 5xx, a byte cap), `robots` in warn mode, `fetchLadder` (plain GET up to a browser through a `LadderClient`: autobrowse's `web GET /fetch`) |
| `@wrenautomation/read/text` | `htmlText`, `pdfText`, `decodeHtml`, `decodeEntities`; `readPage` (HTML to title, text, links, mailtos, tels) |
| `@wrenautomation/read/video` | `watchFile` a video file: ffmpeg cuts and frames, an ear for the speech (`cohereSpeech`), an eye for the frames (`cohereEye`), and a video model's read of the whole file when given (`geminiVideo`, or `geminiReader` with no key check, for a proxy that holds the keys); shot labels. Over a URL: `readYoutube` (captions and chapters by yt-dlp, plus a video model's read of the screen in clips), `readYoutubeByUrl` (the video model alone, no download), `readVideo` (any other video: yt-dlp, then `watchFile`), `readAudio` (a podcast by its audio URL, then `hearAudio`), `watch` over a URL or a file, `flatPlaylist` (what a profile, channel or search holds), `download`. Every reader returns the one `VideoRead` shape |
| `@wrenautomation/read/study` | a study's synthesis reader: the quote gate (`pageQuoted`, `numbersQuoted`), the passages a page is shown by, drafts that cite claims, the markdown report |

Everything is a function of what you pass: a URL, bytes, text, a file path, models, tools. What
searches, stores, schedules or knows a customer belongs to the caller. Every model call goes
through `@wrenautomation/models`. `watch` and the readers over a URL need ffmpeg and yt-dlp.

```ts
import { PoliteFetcher, userAgent } from "@wrenautomation/read/fetch";
import { readPage } from "@wrenautomation/read/text";

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

License: PolyForm Strict 1.0.0 (`LICENSE.md`).
