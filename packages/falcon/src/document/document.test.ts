import { describe, expect, it } from "vitest";
import {
  claimExtractor,
  claimPrompt,
  gateFindings,
  salvageFindings,
  verdictOf,
} from "./extract.js";
import { Cut, type Model } from "./model.js";
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
  it("puts the ask, what is known and the whole document in the prompt; caps nothing", () => {
    const p = claimPrompt(doc, { text: "repeat clients", known: ["referrals convert"] });
    expect(p).toContain("Ask: repeat clients");
    expect(p).toContain("- referrals convert");
    expect(p).toContain(doc.text);
    expect(p).not.toContain("The person says");
    expect(p).not.toMatch(/at most \d+/i);
    expect(p).not.toMatch(/\{\w+\}/);
  });

  it("renders what the person says first, before what is known", () => {
    const p = claimPrompt(doc, { text: "x", steer: ["numbers only", "skip vendor pages"] });
    expect(p).toContain("The person says:\n- numbers only\n- skip vendor pages\nKnown already");
  });

  it("salvages the whole findings of a cut answer; braces and quotes in strings are not structure", () => {
    const partial =
      '{"findings": [{"text": "A {brace} and a \\"quote\\" inside.", "quote": "some five words at least here"}, {"text": "Second one.", "quote": "another five words at least here"}, {"text": "cut mid';
    const out = salvageFindings(partial);
    expect(out.findings).toEqual([
      { text: 'A {brace} and a "quote" inside.', quote: "some five words at least here" },
      { text: "Second one.", quote: "another five words at least here" },
    ]);
    expect(salvageFindings('{"findings": [{"text": "half').findings).toEqual([]);
    expect(salvageFindings("nothing").findings).toEqual([]);
  });

  it("continues a cut answer from the end of the last kept quote, with it known; sums the usage", async () => {
    const prompts: string[] = [];
    let n = 0;
    const model: Model = {
      id: "m1",
      ask: async (p, shape) => {
        prompts.push(p);
        if (n++ === 0)
          throw new Cut(
            "cut",
            '{"findings": [{"text": "38% of placements came from repeat clients.", "quote": "38% of placements came from repeat clients"}, {"text": "Fir',
            { input: 100, output: 50 },
          );
        return {
          value: shape.parse({
            findings: [
              { text: "Referrals cost less than ads.", quote: "referrals were cheaper than ads" },
            ],
            quality: "thin",
            gap: "no cost numbers",
          }),
          usage: { input: 40, output: 20 },
        };
      },
    };
    const out = await claimExtractor.extract(doc, { text: "repeat clients" }, model);
    expect(out.findings.map((f) => f.proof.quote)).toEqual([
      "38% of placements came from repeat clients",
      "referrals were cheaper than ads",
    ]);
    expect(out.usage).toEqual({ input: 140, output: 70 });
    expect(out.continued).toBe(1);
    expect(out.verdict).toEqual({ quality: "thin", gap: "no cost numbers" });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("- 38% of placements came from repeat clients.");
    expect(prompts[1]).toContain("(the rest, after the last finding kept)\n. Firms said referrals");
    expect(prompts[1]).not.toContain("Our 2025 survey");
  });

  it("stops with an error when a cut answer kept nothing: the one case a document stays unread", async () => {
    const model: Model = {
      id: "m1",
      ask: async () => {
        throw new Cut(
          "cut",
          '{"findings": [{"text": "Half.", "quote": "not on the page at all"}, {"te',
        );
      },
    };
    await expect(claimExtractor.extract(doc, { text: "x" }, model)).rejects.toThrow(
      /nothing before the cut passed the gate/,
    );
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
        quality: "rich",
        gap: "No numbers on referral cost.",
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
    expect(out.verdict).toEqual({ quality: "rich", gap: "No numbers on referral cost." });
    expect(out.usage).toEqual({ usd: 0.01 });
  });

  it("corrects the verdict by what the gate kept; an empty document is empty", () => {
    expect(verdictOf({ quality: "rich" }, doc, 0)).toEqual({ quality: "thin" });
    expect(verdictOf({}, doc, 0)).toEqual({ quality: "off" });
    expect(verdictOf({}, doc, 2)).toEqual({ quality: "thin" });
    expect(verdictOf({ quality: "off", gap: " more  numbers " }, doc, 0)).toEqual({
      quality: "off",
      gap: "more numbers",
    });
    expect(verdictOf({ quality: "rich" }, { ...doc, text: " " }, 0)).toEqual({ quality: "empty" });
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
    expect(out.verdict).toEqual({ quality: "thin" });
  });
});
