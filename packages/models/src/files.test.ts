import { describe, expect, it } from "vitest";
import { gemini, geminiFile } from "./providers.js";

describe("geminiFile", () => {
  it("passes a refusing key, waits while the file processes, and pins the key that took it", async () => {
    const asked: { url: string; key: string | null; method: string }[] = [];
    const wire = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const key = new Headers(init?.headers).get("x-goog-api-key");
      asked.push({ url, key, method: init?.method ?? "GET" });
      if (url.endsWith("/upload/v1beta/files"))
        return key === "k-dead"
          ? new Response("{}", { status: 403 })
          : new Response("{}", { headers: { "x-goog-upload-url": "https://up.example/1" } });
      const file = (state: string) => ({
        name: "files/abc",
        uri: "https://generativelanguage.googleapis.com/v1beta/files/abc",
        mimeType: "video/mp4",
        state,
      });
      if (url === "https://up.example/1") return Response.json({ file: file("PROCESSING") });
      if (init?.method === "DELETE") return new Response("{}");
      return Response.json(file("ACTIVE"));
    }) as unknown as typeof fetch;
    const f = await geminiFile(new Uint8Array([1, 2, 3]), {
      key: ["k-dead", "k-live"],
      mediaType: "video/mp4",
      pollMs: 1,
      fetch: wire,
    });
    expect(f.key).toBe("k-live");
    expect(f.name).toBe("files/abc");
    expect(f.part).toEqual({
      type: "video",
      data: new URL("https://generativelanguage.googleapis.com/v1beta/files/abc"),
      mediaType: "video/mp4",
    });
    expect(asked.some((a) => a.url.endsWith("/files/abc") && a.method === "GET")).toBe(true);
    await f.drop();
    expect(asked.at(-1)).toMatchObject({ method: "DELETE", key: "k-live" });
    expect(asked.some((a) => a.url.includes(":generateContent"))).toBe(false);
  });

  it("a Files URL reaches generateContent as fileData, never fetched", async () => {
    const asked: string[] = [];
    const wire = (async (input: string | URL | Request, init?: RequestInit) => {
      asked.push(String(input));
      const body = JSON.parse(String(init?.body)) as { contents: { parts: object[] }[] };
      expect(body.contents[0]?.parts[0]).toMatchObject({
        fileData: { fileUri: "https://generativelanguage.googleapis.com/v1beta/files/abc" },
      });
      return Response.json({
        candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
      });
    }) as unknown as typeof fetch;
    const r = await gemini({ key: "k-live", fetch: wire }).complete({
      prompt: [
        {
          type: "video",
          data: new URL("https://generativelanguage.googleapis.com/v1beta/files/abc"),
          mediaType: "video/mp4",
        },
        { type: "text", text: "look" },
      ],
    });
    expect(r.text).toBe("ok");
    expect(asked).toHaveLength(1);
  });

  it("throws when every key refuses, with no key in the message", async () => {
    const wire = (async () => new Response("no", { status: 403 })) as unknown as typeof fetch;
    const err = await geminiFile(new Uint8Array([1]), {
      key: ["k-0000000001"],
      mediaType: "video/mp4",
      fetch: wire,
    }).catch((e: Error) => e);
    expect(String(err)).toMatch(/every key refused/);
    expect(String(err)).not.toContain("k-0000000001");
  });
});
