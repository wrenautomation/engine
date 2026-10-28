/**
 * The engine from a host's CLI: `addEngineCommands(program, deps)` mounts run, trace, keep,
 * drop, yield and sources with the host's ledger, sources and model; the two model adapters
 * (`anthropicModel`, `gatewayModel`) and `modelOf`, which reads a `--model` spec.
 */
export { anthropicId, anthropicModel } from "./anthropic-model.js";
export {
  addEngineCommands,
  allowList,
  type Common,
  type EngineCliDeps,
  type HostLedger,
  keys,
  modelOf,
  RESUMES,
  resumeWaitMs,
  sourcesHere,
} from "./engine-cli.js";
export { gatewayModel } from "./gateway-model.js";
