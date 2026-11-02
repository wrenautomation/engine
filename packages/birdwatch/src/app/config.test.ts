import { describe, expect, it } from "vitest";
import { configVars } from "./config.js";

describe("config", () => {
  const files: Record<string, string> = {
    "/a.env": "EXA_API_KEY_1=x1\nEXA_API_KEY_2=x2\nOTHER=no\n",
    "/b.env": "WREN_RESTATE_INGRESS_URL=https://ingress\n",
  };
  const read = (f: string) => files[f] ?? "";

  it("takes the keys named, a prefix, a rename; vars win", () => {
    const text = JSON.stringify({
      env: ["/a.env", "/b.env"],
      keys: ["EXA_API_KEY*", "RESTATE_INGRESS_URL=WREN_RESTATE_INGRESS_URL", "MISSING"],
      vars: { BIRDWATCH_CONTACT: "https://wrenautomation.com" },
    });
    expect(configVars(text, read)).toEqual({
      EXA_API_KEY_1: "x1",
      EXA_API_KEY_2: "x2",
      RESTATE_INGRESS_URL: "https://ingress",
      BIRDWATCH_CONTACT: "https://wrenautomation.com",
    });
  });

  it("no keys list: every key of the files", () => {
    expect(Object.keys(configVars(JSON.stringify({ env: ["/a.env"] }), read))).toEqual([
      "EXA_API_KEY_1",
      "EXA_API_KEY_2",
      "OTHER",
    ]);
  });
});
