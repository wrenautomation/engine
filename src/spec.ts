/**
 * A model from one string and the environment, for a CLI flag or a setting (Node only: it can
 * start `claude -p`). Grammar: `fake` | `claude-code[:model]` | `anthropic[:haiku|sonnet|opus|id]` |
 * `gateway[:alias]` | `gemini[:id]` | `cohere[:id]` | `<groq|openrouter|mistral|cerebras|openai>[:id]` |
 * `command:<shell command>` (the prompt on stdin, the answer on stdout).
 */
import { claudeCode, commandModel } from "./command.js";
import { fakeModel } from "./fake.js";
import { type EnvMap, fleetKeys, type RotateOptions } from "./keys.js";
import {
  anthropic,
  COMPATIBLE,
  cohere,
  compatible,
  gateway,
  gemini,
  isCompatible,
} from "./providers.js";
import type { Model } from "./types.js";

export const SPEC_NAMES = [
  "fake",
  "claude-code",
  "anthropic",
  "gateway",
  "gemini",
  "cohere",
  "command",
  ...Object.keys(COMPATIBLE),
] as const;

const keysFor = (env: EnvMap, vendor: string): string[] => {
  const keys = fleetKeys(env, vendor);
  if (keys.length) return keys;
  const upper = vendor.toUpperCase();
  throw new Error(`${vendor} needs ${upper}_API_KEY, or NUM_${upper} and ${upper}_API_KEY_1..N`);
};

/**
 * Keys come from the environment by vendor (`ANTHROPIC_API_KEY`, `GROQ_API_KEY_1`...); the
 * gateway reads `WREN_LLM_GATEWAY_URL` and `WREN_LLM_GATEWAY_TOKEN`. `rotate` sets how a key ring
 * waits when every key is busy.
 */
export function modelFromSpec(
  spec: string,
  env: EnvMap = process.env,
  o: { rotate?: RotateOptions } = {},
): Model {
  const at = spec.indexOf(":");
  const name = at < 0 ? spec : spec.slice(0, at);
  const rest = at < 0 ? undefined : spec.slice(at + 1) || undefined;
  const vendor = (v: string) => ({
    key: keysFor(env, v),
    ...(rest ? { model: rest } : {}),
    ...(o.rotate ? { rotate: o.rotate } : {}),
  });
  switch (name) {
    case "fake":
      return fakeModel();
    case "command":
      if (!rest) throw new Error("command needs the command after `command:`");
      return commandModel(rest);
    case "claude-code":
      return claudeCode(rest);
    case "anthropic":
      return anthropic(vendor("anthropic"));
    case "gemini":
      return gemini(vendor("gemini"));
    case "cohere":
      return cohere(vendor("cohere"));
    case "gateway": {
      const url = env.WREN_LLM_GATEWAY_URL;
      const token = env.WREN_LLM_GATEWAY_TOKEN;
      if (!url || !token)
        throw new Error("gateway needs WREN_LLM_GATEWAY_URL and WREN_LLM_GATEWAY_TOKEN");
      return gateway({ url, token, ...(rest ? { model: rest } : {}) });
    }
    default:
      if (isCompatible(name)) return compatible(name, vendor(name));
      throw new Error(`unknown model '${spec}'; expected one of ${SPEC_NAMES.join(", ")} [:model]`);
  }
}
