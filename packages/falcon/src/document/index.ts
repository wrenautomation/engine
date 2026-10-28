/**
 * The research engine's document side: `Document`, `Finding` and `Proof` (zod, so a ledger
 * parses them back), the reader registry by media, the claim extractor, and the model seam an
 * extractor takes. Who fetched a document and who kept a finding is weaver's and the ledger's.
 */
export * from "./extract.js";
export * from "./model.js";
export * from "./readers.js";
export * from "./types.js";
