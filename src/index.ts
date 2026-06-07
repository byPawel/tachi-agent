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
export { GatewayClient, GatewayHttpError } from "./bridge/openclaw/index.js";
export type { GatewayClientConfig, RunOutcome, RunState, StartedRun } from "./bridge/openclaw/index.js";
import "./drivers/register.js"; // side-effect: register built-in "ollama" + "hermes" drivers
export { createOrchestrator } from "./orchestrator.js";
export type { CreateOrchestratorConfig } from "./orchestrator.js";
export { runSwarm, buildSwarmFromEnv, defaultMakeAgent, SYNTHESIZER_ROLE, memberSessionId, swarmTraceSession } from "./swarm/swarm.js";
export type { RunSwarmOptions } from "./swarm/swarm.js";
export { parseRoles, DEFAULT_ROLES } from "./swarm/roles.js";
export type { SwarmRole, SwarmMember, SwarmResult, SwarmAgent, SwarmDeps } from "./swarm/types.js";
