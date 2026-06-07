/**
 * Shared runtime wiring — every front-end (CLI, MCP server, Telegram, Slack)
 * builds the agent the same way from env, so the wiring lives in ONE place.
 */
import { OllamaDriver } from "./drivers/ollama.js";
import { McpToolHost, type McpServerConfig } from "./host/mcp.js";
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

/**
 * Default tool allowlist — keeps the local-model driver FOCUSED. A 3–8B local
 * model degrades badly when handed all ~70 tools from both servers (it returns
 * empty/garbage), so by default we expose only the council + search + memory
 * tools the depth-1 loop actually needs. Override with TACHI_ALLOW (comma-separated
 * names/prefixes); set TACHI_ALLOW="tachibot_,dokoro_" (or "") to expose everything.
 */
export const DEFAULT_ALLOW = [
  // Multi-model brain — the whole point of the agent. Keep this set SMALL: a local
  // 3–8B driver degrades badly past ~10 tools. Each entry earns its slot:
  "tachibot_tachi",          // smart router → research/solve/architect/judge (single entry point)
  "tachibot_jury",           // multi-model panel + Gemini synthesis (non-trivial judgments)
  "tachibot_planner_maker",  // council-based planning (replaces the weak local planner)
  "tachibot_grok_search",    // grounding search (entity/URL facts)
  "tachibot_perplexity_ask", // grounding search fallback / research
  // dokoro memory — REAL namespaced names. The dokoro package self-prefixes its
  // tools with `dokoro_`, and the ToolHost namespaces with the server name `dokoro`,
  // so they arrive double-prefixed: `dokoro_dokoro_session_recall`. DokoroMemory
  // discovers recall/log by the `…session_recall`/`…session_summary_add` suffix.
  "dokoro_dokoro_session_recall",
  "dokoro_dokoro_session_summary_add",
  "dokoro_dokoro_shared_note_append",  // working-memory scratchpad for memoryInLoop (Memory.note)
  "dokoro_dokoro_workspace_status",
];

function resolveAllow(optsAllow: string[] | undefined): string[] {
  if (optsAllow) return optsAllow;
  const env = process.env.TACHI_ALLOW;
  if (env !== undefined) return env.split(",").map((s) => s.trim()).filter(Boolean);
  return DEFAULT_ALLOW;
}

/** Per-call MCP timeout (ms) from TACHI_CALL_TIMEOUT_MS; undefined → host default (120_000). */
function resolveCallTimeoutMs(): number | undefined {
  const raw = process.env.TACHI_CALL_TIMEOUT_MS;
  if (raw === undefined) return undefined;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/** Build the wired agent runtime from environment variables. Shared by all front-ends. */
export async function buildAgentFromEnv(opts: BuildOptions = {}): Promise<AgentRuntime> {
  const servers = [
    serverFromEnv("dokoro", process.env.DOKORO_CMD),
    serverFromEnv("tachibot", process.env.TACHIBOT_CMD),
  ].filter((s): s is McpServerConfig => s !== null);

  const host = new McpToolHost({ allow: resolveAllow(opts.allow), callTimeoutMs: resolveCallTimeoutMs() });
  if (servers.length) await host.connect(servers);

  const driver = new OllamaDriver();
  const memory = servers.some((s) => s.name === "dokoro")
    ? new DokoroMemory(host, { aiModel: driver.name })
    : undefined;

  // TACHI_FORCE_SEARCH=1 → every run grounds via grok/perplexity before answering,
  // regardless of phrasing. Applied as a factory default so EVERY front-end (cli,
  // repl, slack, telegram, gateway, daemon, run_agent) inherits it; explicit
  // per-call options still override.
  const forceGrounding = /^(1|true|yes|on)$/i.test(process.env.TACHI_FORCE_SEARCH ?? "");

  return {
    host,
    driver,
    memory,
    toolCount: host.tools().length,
    orchestrator: (options) => new Orchestrator(driver, host, memory, { forceGrounding, ...options }),
    close: () => host.close(),
  };
}
