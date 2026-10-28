import { expect, it } from "vitest";
import { Transient } from "./errors.js";
import { cohereEar, compatibleEar, groqEar } from "./hear.js";

const audio = { data: new Uint8Array([1, 2, 3, 4]), mediaType: "audio/wav" };

const wire = (responses: (() => Response)[]) => {
  const forms: { url: string; form: FormData; auth: string | null }[] = [];
  let i = 0;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    forms.push({
      url: String(input),
      form: init?.body as FormData,
      auth: new Headers(init?.headers).get("authorization"),
    });
    const r = responses[Math.min(i++, responses.length - 1)];
    if (!r) throw new Error("no response");
    return r();
  }) as typeof globalThis.fetch;
  return { forms, fetch };
};

const ok = (text: string) => () =>
  new Response(JSON.stringify({ text }), { headers: { "content-type": "application/json" } });

it("posts the OpenAI form and prices a free call by its length", async () => {
  const w = wire([ok(" hello there ")]);
  const ear = groqEar({ key: "g", fetch: w.fetch });
  const heard = await ear.hear(audio, { seconds: 3600, language: "fr" });
  expect(heard).toMatchObject({ text: "hello there", usd: 0, free: true, listUsd: 0.04 });
  const f = w.forms[0];
  expect(f?.url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
  expect(f?.auth).toBe("Bearer g");
  expect(f?.form.get("model")).toBe("whisper-large-v3-turbo");
  expect(f?.form.get("language")).toBe("fr");
  expect(f?.form.get("response_format")).toBe("json");
  expect((f?.form.get("file") as File | undefined)?.name).toBe("audio.wav");
  expect(ear.id).toBe("groq:whisper-large-v3-turbo");
});

it("Cohere's route gets no response_format", async () => {
  const w = wire([ok("hi")]);
  await cohereEar({ key: "c", fetch: w.fetch }).hear(audio);
  expect(w.forms[0]?.form.get("response_format")).toBeNull();
  expect(w.forms[0]?.form.get("model")).toBe("cohere-transcribe-03-2026");
});

it("a busy key hands over to the next", async () => {
  const w = wire([() => new Response("slow down", { status: 429 }), ok("second")]);
  const ear = compatibleEar({
    url: "https://speech.example.com/v1/audio/transcriptions",
    model: "whisper",
    key: ["a", "b"],
    fetch: w.fetch,
  });
  expect((await ear.hear(audio)).text).toBe("second");
  expect(w.forms.map((f) => f.auth)).toEqual(["Bearer a", "Bearer b"]);
});

it("a server with no key sends no header; a busy one throws Transient", async () => {
  const w = wire([() => new Response("", { status: 503 })]);
  const ear = compatibleEar({ url: "http://127.0.0.1:9/t", model: "w", fetch: w.fetch });
  await expect(ear.hear(audio)).rejects.toBeInstanceOf(Transient);
  expect(w.forms[0]?.auth).toBeNull();
});

it("a file over the vendor's cap throws before the call", async () => {
  const w = wire([ok("x")]);
  const ear = compatibleEar({ url: "http://x/t", model: "w", maxBytes: 2, fetch: w.fetch });
  await expect(ear.hear(audio)).rejects.toThrow();
  expect(w.forms).toHaveLength(0);
});
