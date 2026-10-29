import { describe, expect, it } from "vitest";
import { htmlText } from "./text.js";

describe("htmlText", () => {
  it("keeps table rows on one line and drops styles and comments", () => {
    const html = `<html><head><style>td{color:red}</style></head><body><!-- x -->
      <p>Thanks&nbsp;for your order</p>
      <table><tr><td>Pro plan</td><td>$20.00</td></tr><tr><td>Total</td><td>&#36;20.00</td></tr></table>
      <div>Questions? Reply&hellip;</div></body></html>`;
    expect(htmlText(html)).toBe(
      "Thanks for your order\n\nPro plan $20.00\nTotal $20.00\n\nQuestions? Reply…",
    );
  });

  it("turns NUL into a space, since Postgres text refuses it", () => {
    // &#0; reads as U+FFFD (WHATWG); a raw NUL still becomes a space.
    expect(htmlText("<p>Sep 6\u0000Oct 6, 2026 &#0;</p>")).toBe("Sep 6 Oct 6, 2026 \uFFFD");
  });
});

describe("htmlText entities", () => {
  it("reads an out-of-range reference as U+FFFD and knows the full named table", () => {
    expect(htmlText("<p>a &#99999999; b &eacute;&hearts;&rarr;</p>")).toBe("a � b é♥→");
  });
});
