import { describe, expect, it } from "vitest";
import type { Fetcher } from "../fetch/fetcher.js";
import type { LadderClient } from "../fetch/ladder.js";
import { type BrandProbe, brandOf } from "./brand.js";
import { colorsIn, fontOf } from "./votes.js";

const SITE = "https://acme.test/";

function fake(pages: Record<string, string>): Fetcher & { got: string[] } {
  const got: string[] = [];
  return {
    userAgent: "test",
    got,
    async get(url) {
      got.push(url);
      const text = pages[url];
      return text === undefined ? { status: 404, url, text: "" } : { status: 200, url, text };
    },
  };
}

function sites(o: { probe?: BrandProbe; render?: string }): LadderClient & { paths: string[] } {
  const paths: string[] = [];
  return {
    paths,
    async call<T>(_site: string, _m: string, path: string, input?: unknown): Promise<T> {
      const i = input as { from?: string };
      paths.push(i.from ? `${path}:${i.from}` : path);
      if (path === "/brand") {
        if (!o.probe) throw Object.assign(new Error("no route"), { status: 404 });
        return o.probe as T;
      }
      if (i.from === "render" && o.render)
        return {
          finalUrl: SITE,
          status: 200,
          html: o.render,
          tier: "render",
          block: null,
          tries: [],
        } as T;
      throw Object.assign(new Error("offline"), { status: 502 });
    },
  };
}

const SHADCN = `<!doctype html><html><head>
<link rel="stylesheet" href="/app.css">
<link rel="icon" href="/favicon.ico">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&family=Playfair+Display" rel="stylesheet">
</head><body><header><a href="/"><img src="/img/acme-logo.svg" alt="Acme"></a></header>
<main><h1>Hi</h1><a class="btn btn-primary" href="/go">Go</a></main></body></html>`;
const SHADCN_CSS = `
:root { --primary: 221 83% 53%; --background: 0 0% 100%; --foreground: 222 47% 11%; --font-heading: "Playfair Display", serif; }
.dark { --primary: 0 0% 98%; }
@media (prefers-color-scheme: dark) { body { background: #000; } }
body { background: hsl(var(--background)); color: hsl(var(--foreground)); font-family: Inter, ui-sans-serif, sans-serif; }
h1, h2 { font-family: var(--font-heading); }
.btn-primary { background-color: hsl(var(--primary)); color: #fff; }
.btn-primary:hover { background-color: #123456; }
a { color: #e11d48; }
`;

describe("brandOf", () => {
  it("reads a shadcn-style site from its CSS alone", async () => {
    const f = fake({ [SITE]: SHADCN, "https://acme.test/app.css": SHADCN_CSS });
    const b = await brandOf(SITE, { fetcher: f, sites: sites({}) });
    expect(b.from).toEqual(["static"]);
    expect(b.logo).toEqual({ url: "https://acme.test/img/acme-logo.svg", kind: "img" });
    expect(b.palette).toEqual({
      primary: "#2463eb",
      accent: "#e11d48",
      background: "#ffffff",
      text: "#0f1729",
    });
    expect(b.fonts).toEqual({ heading: "Playfair Display", body: "Inter" });
    expect(b.confidence.palette).toBeGreaterThan(0.4);
    expect(b.sheets).toBe(1);
    // font CSS is not fetched
    expect(f.got).toEqual([SITE, "https://acme.test/app.css"]);
  });

  it("takes an inline SVG in the home link as the logo", async () => {
    const svg = `<svg class="site-logo" viewBox="0 0 10 10"><path d="M0 0h10v10H0z" fill="#2463eb"/><path d="M1 1h8v8H1z"/></svg>`;
    const html = `<header><a href="/">${svg}</a></header><style>body{font-family:Inter}</style>`;
    const b = await brandOf(SITE, { fetcher: fake({ [SITE]: html }) });
    expect(b.logo?.kind).toBe("svg");
    expect(Buffer.from(b.logo?.url.split(",")[1] ?? "", "base64").toString()).toBe(svg);
  });

  it("asks a browser when the CSS is thin, and computed styles win", async () => {
    const probe: BrandProbe = {
      finalUrl: SITE,
      status: 200,
      block: null,
      themeColor: null,
      body: {
        background: "rgb(255, 255, 255)",
        color: "rgb(17, 24, 39)",
        font: '"DM Sans", sans-serif',
      },
      headings: [{ font: "Fraunces, serif", color: "rgb(17, 24, 39)" }],
      buttons: [{ background: "rgb(22, 163, 74)", color: "rgb(255,255,255)", area: 4000 }],
      links: [{ color: "rgb(124, 58, 237)" }],
      logos: [{ src: "/logo.png", svg: null, named: true, top: true, area: 3000 }],
    };
    const s = sites({ probe });
    const b = await brandOf(SITE, { fetcher: fake({ [SITE]: "<div id=root></div>" }), sites: s });
    expect(s.paths).toEqual(["/brand"]);
    expect(b.from).toEqual(["static", "browser"]);
    expect(b.palette.primary).toBe("#16a34a");
    expect(b.palette.accent).toBe("#7c3aed");
    expect(b.fonts).toEqual({ heading: "Fraunces", body: "DM Sans" });
    expect(b.logo).toEqual({ url: "https://acme.test/logo.png", kind: "img" });
  });

  it("with no /brand route, reads the render rung's HTML", async () => {
    const s = sites({ render: SHADCN });
    const f = fake({ [SITE]: "<div id=root></div>", "https://acme.test/app.css": SHADCN_CSS });
    const b = await brandOf(SITE, { fetcher: f, sites: s });
    expect(s.paths).toEqual(["/brand", "/fetch:render"]);
    expect(b.from).toEqual(["static", "render"]);
    expect(b.palette.primary).toBe("#2463eb");
  });

  it("never throws: an unreadable site is an empty brand", async () => {
    const b = await brandOf(SITE, { fetcher: fake({}) });
    expect(b).toMatchObject({
      logo: null,
      from: [],
      palette: { primary: null },
      fonts: { body: null },
    });
  });
});

describe("votes", () => {
  it("finds colours in a value", () => {
    expect(colorsIn("1px solid #ccc")).toEqual(["#cccccc"]);
    expect(colorsIn("linear-gradient(90deg, rebeccapurple, rgba(0,0,0,0.1))")).toEqual(["#663399"]);
  });
  it("takes the first named family", () => {
    expect(fontOf('-apple-system, "Segoe UI", Roboto')).toBe("Segoe UI");
    expect(fontOf("600 16px/1.5 Inter, sans-serif", true)).toBe("Inter");
    expect(fontOf('"Font Awesome 6 Free"')).toBeNull();
    expect(fontOf("system-ui, sans-serif")).toBeNull();
  });
});
