import { expect, it } from "vitest";
import { z } from "zod";
import { Unsupported } from "./errors.js";
import { fakeModel, scriptedModel } from "./fake.js";
import { modelOf } from "./model.js";
import { NoAnswer } from "./parse.js";
import type { Request } from "./types.js";

const shape = z.object({ n: z.number() });

it("ask repairs a bad answer once, telling the model why, and sums the usage", async () => {
  const seen: Request[] = [];
  const answers = ["no json here", '{"n": 4}'];
  const m = modelOf({
    id: "t",
    provider: "t",
    async complete(req) {
      seen.push(req);
      return {
        text: answers[seen.length - 1] ?? "",
        usage: { input: 10, output: 2, usd: 0.001 },
        model: "t",
        stop: "end",
        ms: 1,
        raw: {},
      };
    },
  });
  const a = await m.ask("give n", shape, { system: "s" });
  expect(a.value).toEqual({ n: 4 });
  expect(a.usage).toEqual({ input: 20, output: 4, usd: 0.002 });
  expect(seen).toHaveLength(2);
  expect(seen[1]?.system).toBe("s");
  expect(String(seen[1]?.prompt)).toContain("no json here");
});

it("ask with repairs 0 throws NoAnswer", async () => {
  await expect(fakeModel("nothing").ask("x", shape, { repairs: 0 })).rejects.toBeInstanceOf(
    NoAnswer,
  );
});

it("a part the model does not take throws Unsupported, never dropped", async () => {
  const m = modelOf({
    id: "t",
    provider: "t",
    complete: async () => {
      throw new Error("not reached");
    },
  });
  await expect(
    m.complete({ prompt: [{ type: "image", data: "AAAA", mediaType: "image/png" }] }),
  ).rejects.toBeInstanceOf(Unsupported);
});

it("scriptedModel answers in order and throws past the end", async () => {
  const m = scriptedModel([{ n: 1 }, '{"n": 2}']);
  expect((await m.ask("a", shape)).value).toEqual({ n: 1 });
  expect((await m.ask("b", shape)).value).toEqual({ n: 2 });
  await expect(m.complete("c")).rejects.toThrow("no answer 3");
});
