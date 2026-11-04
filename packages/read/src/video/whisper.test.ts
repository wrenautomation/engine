import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { whisperSpeech } from "./whisper.js";

it("whisper hears a clip through whisper-cli: model, language, free", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wt-"));
  const model = join(dir, "m.bin");
  await writeFile(model, "x");
  let args: string[] = [];
  const ear = whisperSpeech({
    model,
    run: async (_bin, a) => {
      args = a;
      return { stdout: " We booked 11 meetings.\n\n In 3 weeks.\n", stderr: "" };
    },
  });
  const heard = await ear.hear(
    { data: new Uint8Array([1]), mediaType: "audio/mpeg" },
    { language: "de" },
  );
  expect(heard).toMatchObject({ text: "We booked 11 meetings. In 3 weeks.", usd: 0, free: true });
  expect(args.slice(0, 4)).toEqual(["-m", model, "-l", "de"]);
  expect(args.at(-1)).toMatch(/in\.mp3$/);
});

it("whisper with no model on disk says where to get it", async () => {
  const ear = whisperSpeech({
    model: "/nope/m.bin",
    run: async () => ({ stdout: "", stderr: "" }),
  });
  await expect(ear.hear({ data: new Uint8Array([1]), mediaType: "audio/mpeg" })).rejects.toThrow(
    /huggingface/,
  );
});
