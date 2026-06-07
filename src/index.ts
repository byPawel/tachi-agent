/**
 * tachi-agent — public API.
 *
 * Extend without forking the core:
 *   1. implement Driver / ToolHost / Memory  (see ./types)
 *   2. optionally registerDriver("name", () => yourDriver)
 *   3. createOrchestrator({ driver, host, memory, options }).run(task)
 *
 * Stop a run: pass options.signal (AbortSignal) and call controller.abort().
 */
export * from "./types.js";
export { Orchestrator } from "./agent.js";
export { registerDriver, getDriver, listDrivers } from "./registry.js";
import "./drivers/register.js"; // side-effect: register built-in "ollama" + "hermes" drivers

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
