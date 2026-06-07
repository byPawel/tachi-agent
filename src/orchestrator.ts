// src/orchestrator.ts
// The Orchestrator factory lives here (not in index.ts) so feature modules like
// src/swarm can build orchestrators without importing the public barrel — which
// would create an index ↔ swarm import cycle. index.ts re-exports these.
import { Orchestrator } from "./agent.js";
import { getDriver } from "./registry.js";
import type { Driver, ToolHost, Memory, OrchestratorOptions } from "./types.js";

export interface CreateOrchestratorConfig {
  /** A Driver instance, or the name of a registered one. */
  driver: Driver | string;
  host: ToolHost;
  memory?: Memory;
  options?: OrchestratorOptions;
}

/** Build an Orchestrator from a Driver instance or a registered driver name. */
export function createOrchestrator(cfg: CreateOrchestratorConfig): Orchestrator {
  const driver = typeof cfg.driver === "string" ? getDriver(cfg.driver) : cfg.driver;
  return new Orchestrator(driver, cfg.host, cfg.memory, cfg.options);
}
