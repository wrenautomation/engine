/**
 * A study's synthesis reader: the quote gate (`grounding`), the passages a page is shown by
 * (`evidence`), drafts that cite claims, and the report. Pure: the caller searches, stores and
 * calls the model. The planner (queries per angle, which pages to read, the claim gate per angle)
 * went in 0.5.0: raven plans, weaver runs, `./document`'s `claimExtractor` is the one gate.
 */
export * from "./claims.js";
export * from "./drafts.js";
export * from "./evidence.js";
export * from "./grounding.js";
export * from "./report.js";
