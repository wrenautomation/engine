/**
 * A study's core: the model's prompts and answer shapes, the quote gate that keeps a claim
 * only when its words are on a page it was shown, which pages to read, drafts that cite
 * claims, and the report. Pure: the caller searches, stores and calls the model.
 */
export * from "./claims.js";
export * from "./drafts.js";
export * from "./evidence.js";
export * from "./grounding.js";
export * from "./report.js";
