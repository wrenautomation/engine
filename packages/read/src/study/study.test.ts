import { describe, expect, it } from "vitest";
import { fill } from "./claims.js";
import { gateDrafts, type NumberedClaim } from "./drafts.js";
import { pageEvidence, passages, terms } from "./evidence.js";
import { numbersQuoted, pageQuoted } from "./grounding.js";
import { type ReportClaim, studyReport } from "./report.js";

const PAGE = {
  url: "https://staffing.example/survey",
  text: "Our 2025 survey of 412 firms found that 38% of placements came from repeat clients. Firms said referrals were cheaper than ads.",
};

describe("grounding", () => {
  it("finds the quote on the named page, then any page, folding quotes and case", () => {
    const other = { url: "https://other.example", text: "Nothing here." };
    expect(pageQuoted("38% of placements came from repeat clients", [other, PAGE], null)?.url).toBe(
      PAGE.url,
    );
    expect(pageQuoted("Our 2025 Survey of 412 firms", [PAGE], "https://wrong.example")?.url).toBe(
      PAGE.url,
    );
    expect(pageQuoted("40% of placements came from repeat clients", [PAGE], PAGE.url)).toBeNull();
  });

  it("matches a quote without the page's markdown", () => {
    const md = {
      url: "https://md.example",
      text: "While **over 60% of firms** plan to automate, per [Bullhorn](https://b.example/r), _few_ do.",
    };
    expect(
      pageQuoted("While over 60% of firms plan to automate, per Bullhorn, few do.", [md], null),
    ).toBe(md);
  });

  it("needs every number in the claim to be in the quote; a year may come from the page", () => {
    expect(numbersQuoted("1,200 firms, 38%", "about 1200 firms and 38% of them")).toBe(true);
    expect(numbersQuoted("40% of firms", "38% of firms")).toBe(false);
    const report = { url: "https://cfo.example/benchmarks-2026.pdf", text: "IT staffing: 30-45%." };
    expect(
      numbersQuoted("2026 benchmarks: IT staffing 30-45%", "IT staffing: 30-45%", report),
    ).toBe(true);
    expect(
      numbersQuoted("2025 benchmarks: IT staffing 30-45%", "IT staffing: 30-45%", report),
    ).toBe(false);
    expect(numbersQuoted("IT staffing 30-46%", "IT staffing: 30-45%", report)).toBe(false);
  });
});

describe("claims", () => {
  it("fills marks once: a mark inside a value stays text", () => {
    expect(fill("{a} and {b}", { a: "{b}", b: "$&" })).toBe("{b} and $&");
  });
});

describe("evidence", () => {
  it("shows the chunks that match, in page order, within the budget", () => {
    const filler = "lorem ipsum dolor sit amet ".repeat(30);
    const text = [
      filler,
      "Recruiting fees average 20 percent of salary.",
      filler,
      "Recruiting firms churn clients.",
    ].join("\n");
    const want = terms("recruiting fees");
    const shown = passages(text, want, 700);
    expect(shown).toContain("Recruiting fees average 20 percent");
    expect(shown).not.toContain("lorem");
    expect(passages("short page", want, 700)).toBe("short page");
  });

  it("caps what the model sees of one page", () => {
    const big = { url: "https://big.example", text: "fees 10\n".repeat(4_000) };
    const out = pageEvidence(big, terms("fees"));
    expect(out.url).toBe(big.url);
    expect(out.text.length).toBeLessThanOrEqual(12_000);
  });
});

const CLAIMS: NumberedClaim[] = [
  {
    n: 1,
    angle: 0,
    claim: "38% of placements come from repeat clients.",
    quote: "38% of placements came from repeat clients",
    source_url: PAGE.url,
  },
  {
    n: 2,
    angle: 0,
    claim: "Firms say referrals are cheaper than ads.",
    quote: "Firms said referrals were cheaper than ads",
    source_url: PAGE.url,
  },
];

describe("drafts", () => {
  const spec = { key: "offers", ask: "Write 5 offers." };

  it("keeps items that cite real claims and carry only cited numbers", () => {
    const { kept, dropped } = gateDrafts(
      {
        items: [
          {
            title: "Repeat desk",
            body: "38% of your placements come back [1]. We win the rest.",
            cites: [1, 2, 1],
          },
          { title: "Made up", body: "We double placements in 30 days.", cites: [1] },
          { title: "No cites", body: "Trust us.", cites: [] },
          { title: "Ghost", body: "Per claim 9.", cites: [9] },
          { title: "Five offers", body: "One of the 5 offers.", cites: [2] },
        ],
      },
      spec,
      CLAIMS,
    );
    expect(kept.map((k) => [k.title, k.cites])).toEqual([
      ["Repeat desk", [1, 2]],
      ["Five offers", [2]],
    ]);
    expect(dropped.map((d) => d.why)).toEqual(["number_not_cited", "no_cites", "unknown_cite"]);
  });

  it("strips citation marks from the text; cites carries them", () => {
    const { kept } = gateDrafts(
      {
        items: [
          {
            title: "Repeat desk [1]",
            body: "38% come back (claim 1). Referrals are cheaper (claims 1 and 2), so [2] ask.",
            cites: [1, 2],
          },
        ],
      },
      spec,
      CLAIMS,
    );
    expect(kept[0]).toMatchObject({
      title: "Repeat desk",
      body: "38% come back. Referrals are cheaper, so ask.",
    });
  });
});

describe("report", () => {
  it("renders claims with marks and calls, drafts with cites, sources once", () => {
    const called: ReportClaim[] = CLAIMS.map((c, i) => ({
      ...c,
      call: i === 1 ? "drop" : null,
      comment: i === 1 ? "marketing" : null,
    }));
    const md = studyReport(
      {
        study: { question: "Should we sell win-back to recruiters?", slug: "demo", niche: null },
        angles: [
          { angle: "Where placements come from", claims: called },
          { angle: "What it costs", claims: [] },
        ],
        drafts: [
          {
            spec: { key: "offers", ask: "Write 5 offers." },
            done: true,
            stale: true,
            kept: [{ title: "Repeat desk", body: "38% come back.", cites: [1] }],
            dropped: [{ title: "Made up", why: "number_not_cited" }],
          },
        ],
        titles: new Map([[PAGE.url, "Staffing survey 2025"]]),
        counts: { queries: 3, pages: 2, unread: 1, gated: 4, waiting: 0 },
      },
      { rerun: "study run demo" },
    );
    expect(md).toContain("- 38% of placements come from repeat clients. [1]");
    expect(md).toContain("- ~~Firms say referrals are cheaper than ads. [2] (drop: marketing)~~");
    expect(md).toContain("1 part still to run: `study run demo`.");
    expect(md).toContain("_Nothing on the pages read answered this._");
    expect(md).toContain("### Repeat desk\n\n38% come back.\n\nCites [1]");
    expect(md).toContain("_Dropped: Made up (number not cited)._");
    expect(md.match(/<https:\/\/staffing\.example\/survey>/g)).toHaveLength(2);
    expect(md).toContain('1. Staffing survey 2025, <https://staffing.example/survey>: "38%');
  });
});
