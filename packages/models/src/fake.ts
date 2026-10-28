/** Models for tests and dry runs: no network, no keys. */
import { modelOf, promptText } from "./model.js";
import type { Model, Reply, Request } from "./types.js";

const reply = (text: string, model: string): Reply => ({
  text,
  usage: {},
  model,
  stop: "end_turn",
  ms: 0,
  raw: { fake: true },
});

/** Answers each call from `respond` (the prompt's text and the system), or a fixed string. */
export function fakeModel(
  respond: string | ((prompt: string, req: Request) => string | Promise<string>) = "{}",
  id = "fake",
): Model {
  return modelOf({
    id,
    provider: "fake",
    takes: new Set(["text", "image", "video", "audio", "pdf"]),
    async complete(req) {
      const text =
        typeof respond === "string" ? respond : await respond(promptText(req.prompt) ?? "", req);
      return reply(text, id);
    },
  });
}

/** Answers from a fixed list, in order; an object answer is sent as its JSON. Throws past the end. */
export function scriptedModel(answers: readonly unknown[], id = "scripted"): Model {
  let i = 0;
  return fakeModel(() => {
    const a = answers[i++];
    if (a === undefined) throw new Error(`scripted model has no answer ${i}`);
    return typeof a === "string" ? a : JSON.stringify(a);
  }, id);
}
