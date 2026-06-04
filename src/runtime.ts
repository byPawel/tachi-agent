/**
 * Shared runtime wiring — every front-end (CLI, MCP server, Telegram, Slack)
 * builds the agent the same way from env, so the wiring lives in ONE place.
 */
import { OllamaDriver } from "./drivers/ollama.js";
import { McpToolHost, type McpServerConfig, type McpToolHostOptions } from "./host/mcp.js";
import { DokoroMemory } from "./memory/dokoro.js";
import { Orchestrator } from "./agent.js";
import type { Driver, Memory, OrchestratorOptions } from "./types.js";

export interface AgentRuntime {
  host: McpToolHost;
  driver: Driver;
  memory?: Memory;
  toolCount: number;
  /** Make a fresh orchestrator with per-run options (signal, onEvent, caps). */
  orchestrator(options?: OrchestratorOptions): Orchestrator;
  close(): Promise<void>;
}

/** Parse a `"command arg arg"` env string into an McpServerConfig (or null if unset). */
export function serverFromEnv(name: string, val: string | undefined): McpServerConfig | null {
  if (!val || !val.trim()) return null;
  const [command, ...args] = val.trim().split(/\s+/);
  return { name, command, args };
}

export interface BuildOptions {
  /** Security allowlist passed to the ToolHost (exact names or `${server}_` prefixes). */
  allow?: string[];
}

/** Build the wired agent runtime from environment variables. Shared by all front-ends. */
export async function buildAgentFromEnv(opts: BuildOptions = {}): Promise<AgentRuntime> {
  const servers = [
    serverFromEnv("dokoro", process.env.DOKORO_CMD),
    serverFromEnv("tachibot", process.env.TACHIBOT_CMD),
  ].filter((s): s is McpServerConfig => s !== null);

  const hostOpts: McpToolHostOptions = opts.allow ? { allow: opts.allow } : {};
  const host = new McpToolHost(hostOpts);
  if (servers.length) await host.connect(servers);

  const driver = new OllamaDriver();
  const memory = servers.some((s) => s.name === "dokoro") ? new DokoroMemory(host) : undefined;

  return {
    host,
    driver,
    memory,
    toolCount: host.tools().length,
    orchestrator: (options) => new Orchestrator(driver, host, memory, options),
    close: () => host.close(),
  };
}
