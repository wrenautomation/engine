/**
 * Batch calls: Anthropic Message Batches, half the list price, answers within 24 h. For judgments
 * nobody waits on (nightly scores, labels, a backfill); a waited-on call stays `Model.complete`.
 * `batch` sends and returns the batch id; `batchResults` reads it, answers once it has ended.
 * The caller keeps the id (a batch outlives the process) and parses each reply (`parseAnswer`).
 */
import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlockParam,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/messages/messages";
import { Unsupported } from "./errors.js";
import { asRequest, checkParts } from "./model.js";
import { wellFormed } from "./parse.js";
import { priced } from "./prices.js";
import { anthropicModelId } from "./providers.js";
import { DEFAULT_MAX_TOKENS } from "./sdk.js";
import type { Part, PartKind, Reply, Request, Source, Usage } from "./types.js";

/** One call in a batch; `id` comes back on its answer (1-64 chars: letters, digits, `_`, `-`). */
export interface BatchItem {
  id: string;
  request: Request | string;
}

export interface BatchAnswer {
  id: string;
  /** Absent when the call failed; `error` says why. */
  reply?: Reply;
  error?: string;
}

export interface BatchCounts {
  running: number;
  ok: number;
  failed: number;
}

export type BatchStatus =
  | { id: string; state: "running"; counts: BatchCounts }
  | { id: string; state: "ended"; counts: BatchCounts; answers: BatchAnswer[] };

export interface Batcher {
  /** As `Model.id`: the answering model. */
  readonly id: string;
  readonly provider: string;
  batch(items: readonly BatchItem[]): Promise<{ id: string }>;
  batchResults(id: string): Promise<BatchStatus>;
}

/** The SDK's batch calls; a test passes its own. */
export type BatchWire = Pick<Anthropic["messages"]["batches"], "create" | "retrieve" | "results">;

/** Anthropic's batch discount on every token, cache reads and writes included. */
export const BATCH_SHARE = 0.5;
const FLOOR_TOKENS = 2048;
const TAKES: ReadonlySet<PartKind> = new Set(["text", "image", "pdf"]);
const ITEM_ID = /^[\w-]{1,64}$/;

const base64 = (d: Source) =>
  d instanceof Uint8Array ? Buffer.from(d).toString("base64") : String(d);
const isUrl = (d: Source) => d instanceof URL || /^https?:\/\//.test(String(d));

function block(p: Part): ContentBlockParam {
  switch (p.type) {
    case "text":
      return { type: "text", text: wellFormed(p.text) };
    case "image":
      return isUrl(p.data)
        ? { type: "image", source: { type: "url", url: String(p.data) } }
        : {
            type: "image",
            source: {
              type: "base64",
              media_type: p.mediaType as "image/png",
              data: base64(p.data),
            },
          };
    case "pdf":
      return isUrl(p.data)
        ? { type: "document", source: { type: "url", url: String(p.data) } }
        : {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: base64(p.data) },
          };
    default:
      throw new Unsupported("batch", p.type);
  }
}

/** A `Request` as Messages API params: the system carries a cache breakpoint, as on one call. */
export function batchParams(model: string, req: Request): MessageCreateParamsNonStreaming {
  checkParts(model, TAKES, req.prompt);
  return {
    model,
    max_tokens: Math.max(req.maxTokens ?? DEFAULT_MAX_TOKENS, FLOOR_TOKENS),
    ...(req.system
      ? {
          system: [
            { type: "text", text: wellFormed(req.system), cache_control: { type: "ephemeral" } },
          ],
        }
      : {}),
    messages: [
      {
        role: "user",
        content: typeof req.prompt === "string" ? wellFormed(req.prompt) : req.prompt.map(block),
      },
    ],
    ...(req.effort ? { output_config: { effort: req.effort } } : {}),
  };
}

/** Claude through Message Batches on one key: a batch lives under the key's org. */
export function anthropicBatch(o: {
  key: string;
  /** A model id or a short name; default Haiku. */
  model?: string;
  wire?: BatchWire;
  fetch?: typeof fetch;
}): Batcher {
  const model = anthropicModelId(o.model ?? "haiku");
  const wire =
    o.wire ??
    new Anthropic({ apiKey: o.key, maxRetries: 2, ...(o.fetch ? { fetch: o.fetch } : {}) }).messages
      .batches;
  return {
    id: model,
    provider: "anthropic",
    async batch(items) {
      if (!items.length) throw new Error("batch: no items");
      const seen = new Set<string>();
      for (const i of items) {
        if (!ITEM_ID.test(i.id)) throw new Error(`batch: bad item id ${JSON.stringify(i.id)}`);
        if (seen.has(i.id)) throw new Error(`batch: item id ${i.id} twice`);
        seen.add(i.id);
      }
      const b = await wire.create({
        requests: items.map((i) => ({
          custom_id: i.id,
          params: batchParams(model, asRequest(i.request)),
        })),
      });
      return { id: b.id };
    },
    async batchResults(id) {
      const b = await wire.retrieve(id);
      const c = b.request_counts;
      const counts = {
        running: c.processing,
        ok: c.succeeded,
        failed: c.errored + c.canceled + c.expired,
      };
      if (b.processing_status !== "ended") return { id, state: "running", counts };
      const ms = b.ended_at ? Date.parse(b.ended_at) - Date.parse(b.created_at) : 0;
      const answers: BatchAnswer[] = [];
      for await (const r of await wire.results(id)) {
        const res = r.result;
        if (res.type !== "succeeded") {
          answers.push({
            id: r.custom_id,
            error:
              res.type === "errored"
                ? `${res.error.error.type}: ${res.error.error.message}`.slice(0, 300)
                : res.type,
          });
          continue;
        }
        const m = res.message;
        const u = m.usage;
        const cacheRead = u.cache_read_input_tokens ?? 0;
        const cacheWrite = u.cache_creation_input_tokens ?? 0;
        const tokens: Usage = {
          input: u.input_tokens + cacheRead + cacheWrite,
          output: u.output_tokens,
          ...(cacheRead ? { cacheRead } : {}),
          ...(cacheWrite ? { cacheWrite } : {}),
        };
        const usage = priced(model, tokens);
        if (usage.usd !== undefined) usage.usd *= BATCH_SHARE;
        answers.push({
          id: r.custom_id,
          reply: {
            text: m.content.flatMap((x) => (x.type === "text" ? [x.text] : [])).join(""),
            usage,
            model: m.model,
            stop: m.stop_reason ?? undefined,
            ms,
            raw: { batch: id, message: m.id },
          },
        });
      }
      return { id, state: "ended", counts, answers };
    },
  };
}
