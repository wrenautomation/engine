/**
 * The open web by HTTP: a polite fetcher (one request at a time per host, a real User-Agent with a
 * contact, retries on 429 and 5xx, a byte cap), robots.txt in warn mode, and the fetch ladder
 * that climbs from a plain GET to a browser (`LadderClient`: autobrowse's `web GET /fetch`).
 * Turning the page into text is `./text`'s. No database here.
 */
export * from "./fetcher.js";
export * from "./ladder.js";
export * from "./robots.js";
