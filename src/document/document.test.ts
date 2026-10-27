import { describe, expect, it } from "vitest";
import { claimExtractor, claimPrompt, gateFindings } from "./extract.js";
import type { Model } from "./model.js";
import { defaultReaders, mediaOf } from "./readers.js";
import { Document, Finding, Proof } from "./types.js";

const doc: Document = {
  url: "https://staffing.example/survey",
  media: "html",
  text: "Our 2025 survey of 412 firms found that 38% of placements came from repeat clients. Firms said referrals were cheaper than ads.",
};

const scripted = (answers: unknown[], id = "m1"): Model => {
  let i = 0;
  return {
    id,
    ask: async (_p, shape) => ({ value: shape.parse(answers[i++]), usage: { usd: 0.01 } }),
  };
};

describe("shapes", () => {
  it("a proof needs a quote, a timestamp or a frame", () => {
    expect(Proof.safeParse({ url: "https://a" }).success).toBe(false);
    expect(Proof.safeParse({ url: "https://a", timestamp: 12 }).success).toBe(true);
    expect(
      Finding.safeParse({ kind: "claim", text: "x", proof: { url: "u", quote: "q" } }).success,
    ).toBe(true);
    expect(Document.safeParse({ url: "u", media: "wiki", text: "" }).success).toBe(false);
  });
});

describe("readers", () => {
  it("reads html to a document with the page's title and the hit's free fields", async () => {
    const r = defaultReaders().get("html");
    const d = await r?.read({
      url: "https://a/p",
      text: "<html><head><title>Repeat</title></head><body><p>Hello <b>there</b></p></body></html>",
      channel: "c",
    });
    expect(d).toMatchObject({ url: "https://a/p", media: "html", title: "Repeat", channel: "c" });
    expect(d?.text).toContain("Hello there");
  });

  it("reads text, and an empty body is null", async () => {
    const r = defaultReaders().get("text");
    expect(await r?.read({ url: "u", text: "  a \n\n\n b " })).toMatchObject({ text: "a\n\nb" });
    expect(await r?.read({ url: "u", text: " " })).toBeNull();
  });

  it("names the media from the content type, then the extension", () => {
    expect(mediaOf("text/html; charset=utf-8", "https://a/x")).toBe("html");
    expect(mediaOf("application/pdf", "https://a/x")).toBe("pdf");
    expect(mediaOf(null, "https://a/report.PDF")).toBe("pdf");
    expect(mediaOf("application/octet-stream", "https://a/talk.mp4")).toBe("video");
    expect(mediaOf("application/octet-stream", "https://a/blob")).toBeNull();
  });
});

describe("claim extractor", () => {
  it("puts the ask, what is known and the whole document in the prompt", () => {
    const p = claimPrompt(doc, { text: "repeat clients", known: ["referrals convert"] });
    expect(p).toContain("Ask: repeat clients");
    expect(p).toContain("- referrals convert");
    expect(p).toContain(doc.text);
  });

  it("keeps a finding whose quote is on the document, drops the rest with why", async () => {
    const model = scripted([
      {
        findings: [
          {
            text: "38% of placements came from repeat clients, a 2025 survey found.",
            quote: "38% of placements came from repeat clients",
          },
          { text: "Half of firms use ads.", quote: "Half of firms use ads" },
          {
            text: "Referrals cost less than ads, firms said.",
            quote: "referrals were cheaper than ads",
          },
          {
            text: "A 40% share came from repeat clients.",
            quote: "38% of placements came from repeat clients",
          },
          { text: "Short.", quote: "tiny" },
        ],
      },
    ]);
    const out = await claimExtractor.extract(doc, { text: "repeat clients" }, model);
    expect(out.findings.map((f) => f.proof.quote)).toEqual([
      "38% of placements came from repeat clients",
      "referrals were cheaper than ads",
    ]);
    expect(out.findings[0]).toMatchObject({ kind: "claim", proof: { url: doc.url } });
    expect(out.dropped.map((d) => d.why)).toEqual([
      "quote_not_found",
      "number_not_in_quote",
      "no_quote",
    ]);
    expect(out.usage).toEqual({ usd: 0.01 });
  });

  it("lets a year come from the document and dedupes by quote", () => {
    const out = gateFindings(
      {
        findings: [
          { text: "In 2025, 412 firms answered.", quote: "survey of 412 firms found" },
          { text: "Again 412 firms answered.", quote: "survey of 412 firms found" },
        ],
      },
      doc,
    );
    expect(out.findings).toHaveLength(1);
    expect(out.dropped).toEqual([]);
  });
});
