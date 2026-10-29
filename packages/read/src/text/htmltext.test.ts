import { describe, expect, it } from "vitest";
import { decodeEntities, looksLikeJsShell, readPage } from "./htmltext.js";

const PAGE = `
<html><head><title> Acme  Advisors </title>
<style>body { color: red }</style>
<script>var x = "SCRIPT NOISE <b>not a tag</b>";</script>
</head>
<body>
<h1>Our Team</h1>
<p>Jane Doe is the <b>founder</b>.</p>
<a href="/team">Meet the team</a>
<a href="mailto:info@acme.example">Email us</a>
<a href="https://other.example/x#y">External</a>
<noscript>NOSCRIPT NOISE</noscript>
</body></html>
`;

describe("readPage", () => {
  it("reads text, title and links", () => {
    const page = readPage(PAGE, "https://acme.example/about");
    expect(page.title).toBe("Acme Advisors");
    expect(page.text).toContain("Jane Doe is the founder.");
    expect(page.text).toContain("Our Team");
    expect(page.text).not.toContain("SCRIPT NOISE");
    expect(page.text).not.toContain("NOSCRIPT NOISE");
    expect(page.links).toContainEqual({
      url: "https://acme.example/team",
      anchor: "Meet the team",
    });
    expect(page.links).toContainEqual({ url: "https://other.example/x#y", anchor: "External" });
    expect(page.links.some((l) => l.url.startsWith("mailto:"))).toBe(false);
  });

  it("block elements break lines", () => {
    expect(readPage("<div>one</div><div>two</div>").text).toBe("one\ntwo");
    expect(readPage("a<br/>b<br>c").text).toBe("a\nb\nc");
  });

  it("malformed html degrades gracefully", () => {
    expect(readPage("<p>hello <b>world").text).toContain("hello world");
    expect(readPage('<a href="x').text).toBe("");
    expect(readPage("<!-- never closed").text).toBe("");
  });

  it("captures mailto and tel hrefs", () => {
    expect(readPage(PAGE).mailtos).toEqual(["info@acme.example"]);
    const multi = readPage(
      '<a href="mailto:a%40x.com,b@y.com?subject=Hi&body=x">write</a>' +
        '<a href="tel:+1-555-0100">call</a>' +
        '<a href="mailto:">broken</a>',
    );
    expect(multi.mailtos).toEqual(["a@x.com", "b@y.com"]);
    expect(multi.tels).toEqual(["+1-555-0100"]);
  });

  it("decodes entities in text and attributes", () => {
    const page = readPage(
      '<p>Tom &amp; Jerry &#8212; &#x27;hi&#x27; &eacute;</p><a href="/a?x=1&amp;y=2">l</a>',
      "https://x.example",
    );
    expect(page.text).toBe("Tom & Jerry — 'hi' é\nl");
    expect(page.links[0]?.url).toBe("https://x.example/a?x=1&y=2");
    expect(decodeEntities("&unknownthing; &lt;")).toBe("&unknownthing; <");
  });

  it("skips comments, doctype and javascript/fragment links", () => {
    const page = readPage(
      '<!DOCTYPE html><!-- c --><a href="javascript:void(0)">j</a><a href="#top">t</a><p>x</p>',
    );
    expect(page.links).toEqual([]);
    expect(page.text).toBe("jt\nx");
  });
});

const SHELL =
  "<html><head><script src='/a.js'></script><script src='/b.js'></script>" +
  "<script src='/c.js'></script></head>" +
  `<body><div id="root"></div>${"<!-- pad -->".repeat(200)}</body></html>`;

describe("looksLikeJsShell", () => {
  it("fires on SPA mount points", () => {
    expect(looksLikeJsShell(SHELL, readPage(SHELL).text)).toBe(true);
  });
  it("does not fire on a tiny server-rendered page", () => {
    const html = "<html><body><p>Email us: hi@x.com</p></body></html>";
    expect(looksLikeJsShell(html, readPage(html).text)).toBe(false);
  });
  it("does not fire on a wordy page", () => {
    const html = `<html><body><div id="root"><p>${"words all the way down. ".repeat(30)}</p></div></body></html>`;
    expect(looksLikeJsShell(html, readPage(html).text)).toBe(false);
  });
  it("fires on script-heavy thin markup without a marker", () => {
    const html = `<html><head>${"<script src='/x.js'></script>".repeat(3)}</head><body>${" ".repeat(2000)}</body></html>`;
    expect(looksLikeJsShell(html, "")).toBe(true);
  });
});

describe("decodeEntities surrogates", () => {
  it("reads a surrogate character reference as U+FFFD", () => {
    expect(decodeEntities("a&#xD83D;b&#55357;c")).toBe("a\uFFFDb\uFFFDc");
  });
});

describe("decodeEntities named table", () => {
  it("knows names beyond the common handful", () => {
    expect(decodeEntities("&Aacute;&hearts;&rarr;&nbsp;x &#99999999;")).toBe("Á♥→ x �");
  });
});

describe("readPage structure", () => {
  it("reads the body when </head> is omitted", () => {
    const page = readPage(
      "<html><head><title>Acme</title><meta charset=utf-8><p>Call us today</p>",
    );
    expect(page.title).toBe("Acme");
    expect(page.text).toBe("Call us today");
  });

  it("keeps table cells and list items apart", () => {
    const page = readPage(
      "<table><tr><td>team@acme.test</td><td>Careers</td></tr></table><ul><li>One</li></ul><nav>Home</nav><footer>Legal</footer>",
    );
    expect(page.text.split("\n")).toEqual(["team@acme.test", "Careers", "One", "Home", "Legal"]);
  });

  it("decodes an entity once, not twice", () => {
    expect(readPage("<p>&amp;lt;b&amp;gt;</p>").text).toBe("&lt;b&gt;");
  });
});
