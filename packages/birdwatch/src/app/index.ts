/**
 * The engine from a host's CLI: `addEngineCommands(program, deps)` mounts the agent's commands,
 * trace, yield and sources with the host's ledger, sources and model. A `--model` spec is read by
 * `@wrenautomation/models/spec`.
 */
export {
  addEngineCommands,
  allowList,
  type Common,
  type EngineCliDeps,
  type HostLedger,
  keys,
  sourcesHere,
} from "./engine-cli.js";
