import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  Cut,
  InputRejected,
  isCut,
  isRefused,
  isTransient,
  Refused,
  retryAfterIso,
  statusError,
  Transient,
} from "./errors.js";
import { NoAnswer, parseAnswer, wellFormed } from "./parse.js";

describe("statusError", () => {
  it("sorts a status by what the caller does next", () => {
    expect(statusError("x", 429, "30")).toBeInstanceOf(Transient);
    expect(statusError("x", 503)).toBeInstanceOf(Transient);
    expect(statusError("x", 401)).toBeInstanceOf(Refused);
    expect(statusError("x", 402)).toBeInstanceOf(Refused);
    expect(statusError("x", 422)).toBeInstanceOf(InputRejected);
    expect(statusError("x", 404).name).toBe("Error");
  });
});

it("retryAfterIso reads seconds and dates", () => {
  const now = () => new Date("2026-10-27T00:00:00Z");
  expect(retryAfterIso("30", now)).toBe("2026-10-27T00:00:30.000Z");
  expect(retryAfterIso("Tue, 27 Oct 2026 01:00:00 GMT", now)).toBe("2026-10-27T01:00:00.000Z");
  expect(retryAfterIso("soon", now)).toBeUndefined();
  expect(retryAfterIso(null, now)).toBeUndefined();
});

it("checks by shape, so a second copy of the package still matches", () => {
  const foreign = Object.assign(new Error("cut"), { name: "Cut", partial: "abc" });
  expect(isCut(foreign)).toBe(true);
  expect(isCut(new Cut("m", "p"))).toBe(true);
  expect(isCut(new Error("m"))).toBe(false);
  expect(isTransient(new Transient("t"))).toBe(true);
  expect(isRefused(new Refused("r", 401))).toBe(true);
});

describe("parseAnswer", () => {
  const shape = z.object({ a: z.number() });
  it("finds the object past prose, fences and stray braces", () => {
    expect(parseAnswer('Sure {not json} here:\n```json\n{"a": 1}\n```', shape)).toEqual({ a: 1 });
  });
  it("skips an object of the wrong shape for one of the right shape", () => {
    expect(parseAnswer('{"b": 2} {"a": 3}', shape)).toEqual({ a: 3 });
  });
  it("throws NoAnswer with why the closest failed", () => {
    try {
      parseAnswer('{"a": "x"}', shape);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(NoAnswer);
      expect((err as NoAnswer).issues).toContain("a:");
    }
  });
});

it("wellFormed drops lone surrogates and keeps pairs", () => {
  expect(wellFormed("a\uD800b😀")).toBe("ab😀");
});
