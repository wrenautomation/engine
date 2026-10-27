/**
 * An OpenAI-compatible chat endpoint as raven's `Model`: Wren's LLM gateway
 * (`POST <url>/v1/chat/completions`, a bearer token, an alias such as `free`), or any server
 * that speaks the same. The answer is parsed with raven's shape; the usage is the tokens it reports.
 * An answer the output cap cut (`finish_reason: length`) is falcon's `Cut`, the text so far with it.
 */
import { Cut } from "@wrenautomation/falcon/document";
import { type Model, parseAnswer } from "@wrenautomation/raven";
import { httpError, transport } from "../engine/transient.js";

interface Completion {
  choices?: { message?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string } | string;
}

/** `<url>/v1/chat/completions`; a URL given with its `/v1` (wren's way) is not doubled. */
export const endpoint = (url: string) =>
  `${url.replace(/\/$/, "").replace(/\/v1$/, "")}/v1/chat/completions`;

export function gatewayModel(o: {
  url: string;
  token?: string | null;
  model?: string;
  fetchFn?: typeof fetch;
}): Model {
  const fetchFn = o.fetchFn ?? fetch;
  const model = o.model ?? "free";
  return {
    id: `gateway:${model}`,
    async ask(prompt, shape) {
      const res = await fetchFn(endpoint(o.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          response_format: { type: "json_object" },
        }),
        signal: AbortSignal.timeout(120_000),
      }).catch((err) => {
        throw transport(`gateway ${model}`, err);
      });
      const body = (await res.json().catch(() => ({}))) as Completion;
      if (!res.ok) {
        const why = typeof body.error === "string" ? body.error : body.error?.message;
        throw httpError(`gateway ${model}`, res, why);
      }
      const text = body.choices?.[0]?.message?.content;
      if (!text) throw new Error(`gateway ${model}: empty answer`);
      const u = body.usage;
      const usage = u
        ? {
            ...(u.prompt_tokens !== undefined ? { input: u.prompt_tokens } : {}),
            ...(u.completion_tokens !== undefined ? { output: u.completion_tokens } : {}),
          }
        : undefined;
      if (body.choices?.[0]?.finish_reason === "length")
        throw new Cut(`gateway ${model}: the answer was cut by the output cap`, text, usage);
      return { value: parseAnswer(text, shape), ...(usage ? { usage } : {}) };
    },
  };
}
