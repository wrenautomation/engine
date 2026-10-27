import { describe, expect, it, vi } from "vitest";
import { Refused, Transient } from "./errors.js";
import { fakeModel } from "./fake.js";
import { fleetKeys, rotating } from "./keys.js";
import { modelOf } from "./model.js";

describe("fleetKeys", () => {
  it("reads the numbered ring, passing over gaps and inline notes", () => {
    const env = {
      NUM_GROQ: "3",
      GROQ_API_KEY_1: "a # first",
      GROQ_API_KEY_3: "c",
      GROQ_API_KEY: "x",
    };
    expect(fleetKeys(env, "groq")).toEqual(["a", "c"]);
  });
  it("falls back to the single key", () => {
    expect(fleetKeys({ COHERE_API_KEY: " k " }, "cohere")).toEqual(["k"]);
    expect(fleetKeys({}, "cohere")).toEqual([]);
  });
});

const failing = (err: () => Error, calls: string[], name: string) =>
  modelOf({
    id: "m",
    provider: "p",
    complete: async () => {
      calls.push(name);
      throw err();
    },
  });

describe("rotating", () => {
  it("a refused key hands over at once, with no wait", async () => {
    const calls: string[] = [];
    const sleep = vi.fn(async () => {});
    const m = rotating([failing(() => new Refused("bad", 401), calls, "a"), fakeModel("ok")], {
      passes: 3,
      sleep,
    });
    expect((await m.complete("x")).text).toBe("ok");
    expect(calls).toEqual(["a"]);
    expect(sleep).not.toHaveBeenCalled();
  });
  it("a busy ring waits between passes, then throws the last error", async () => {
    const calls: string[] = [];
    const sleep = vi.fn(async () => {});
    const m = rotating(
      [
        failing(() => new Transient("busy", { status: 429 }), calls, "a"),
        failing(() => new Transient("busy", { status: 429 }), calls, "b"),
      ],
      { passes: 2, sleep, waitMs: 100 },
    );
    await expect(m.complete("x")).rejects.toBeInstanceOf(Transient);
    expect(calls).toEqual(["a", "b", "a", "b"]);
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(100);
  });
  it("an all-refused ring stops after one pass", async () => {
    const calls: string[] = [];
    const sleep = vi.fn(async () => {});
    const m = rotating(
      [
        failing(() => new Refused("bad", 401), calls, "a"),
        failing(() => new Refused("bad", 403), calls, "b"),
      ],
      { passes: 3, sleep },
    );
    await expect(m.complete("x")).rejects.toBeInstanceOf(Refused);
    expect(calls).toEqual(["a", "b"]);
    expect(sleep).not.toHaveBeenCalled();
  });
  it("any other error is the request's and throws at once", async () => {
    const calls: string[] = [];
    const m = rotating([failing(() => new Error("bad prompt"), calls, "a"), fakeModel("ok")]);
    await expect(m.complete("x")).rejects.toThrow("bad prompt");
    expect(calls).toEqual(["a"]);
  });
});
