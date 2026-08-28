#!/usr/bin/env node
/**
 * run_agent MCP server — exposes tachi-agent as a single MCP tool so Claude Code
 * (or any MCP host) can call it for an INDEPENDENT cross-vendor verdict
 * (e.g. "verify HEAD against ADR-1..3"). The whole point: the host model
 * delegates judgment it can't trust itself to give to an uncorrelated council.
 *
 * Pre-mortem mitigations baked in:
 *  - SINGLETON runtime: built ONCE at startup and reused across calls. Building
 *    per-request would spawn fresh dokoro+tachibot child MCP processes every call
 *    → process explosion / EMFILE. (#1)
 *  - BOUNDED run: every call caps maxIterations + timeout so it can't hang the
 *    MCP client. (#3)
 *  - GRACEFUL shutdown: SIGINT/SIGTERM → runtime.close() so child MCP processes
 *    don't become zombies.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { buildAgentFromEnv, type AgentRuntime } from "../runtime.js";
import { loadUserEnv } from "../env-bootstrap.js";

export const DEFAULT_MAX_ITERATIONS = 8;
export const DEFAULT_TIMEOUT_MS = 90_000;
export const MAX_TIMEOUT_MS = 3_600_000;

/**
 * run_agent timeout (ms) from TACHI_RUN_TIMEOUT_MS; fail-soft → DEFAULT_TIMEOUT_MS,
 * clamped to MAX_TIMEOUT_MS. The MCP client's own per-call timeout must also be
 * raised to match (Claude Code: MCP_TOOL_TIMEOUT) or the client gives up first.
 */
export function resolveRunTimeoutMs(): number {
  const raw = process.env.TACHI_RUN_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_TIMEOUT_MS;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
}

export interface RunAgentArgs {
  task: string;
  maxIterations?: number;
  timeoutMs?: number;
}

interface TextResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/**
 * Pure handler — bounded run + result formatting. Extracted so it's unit-testable
 * with a fake runtime (no SDK/stdio/child-processes needed).
 */
export async function runAgentHandler(
  runtime: Pick<AgentRuntime, "orchestrator">,
  args: RunAgentArgs,
  defaults: { maxIterations: number; timeoutMs: number } = {
    maxIterations: DEFAULT_MAX_ITERATIONS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  },
): Promise<TextResult> {
  const timeoutMs = Math.min(args.timeoutMs ?? defaults.timeoutMs, MAX_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await runtime
      .orchestrator({
        maxIterations: args.maxIterations ?? defaults.maxIterations,
        timeoutMs,
        signal: controller.signal,
      })
      .run(args.task);
    const header = `[halted: ${res.haltedBy} · ${res.iterations} steps · ${res.toolCalls.length} tool calls]`;
    return { content: [{ type: "text", text: `${header}\n\n${res.answer}` }] };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { content: [{ type: "text", text: `tachi-agent error: ${msg}` }], isError: true };
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  await loadUserEnv(); // ~/.tachi/.env as defaults — real env vars win
  const runtime = await buildAgentFromEnv(); // singleton — built once, reused

  const server = new McpServer({ name: "tachi-agent", version: "0.1.0" });
  const runTimeoutMs = resolveRunTimeoutMs();

  server.registerTool(
    "run_agent",
    {
      title: "Run TachiAgent",
      description:
        "Run the local tachi-agent for an INDEPENDENT cross-vendor verdict on a task " +
        "(e.g. 'verify HEAD against ADR-1..3'). Driven by a local model, it consults a " +
        "multi-model council — use it for an uncorrelated second opinion the calling model " +
        "can't give itself. Bounded by maxIterations + timeout.",
      inputSchema: {
        task: z.string().describe("The task or question (e.g. 'verify branch X against the ADRs')"),
        maxIterations: z
          .number().int().positive().max(20).optional()
          .describe(`ReAct loop cap (default ${DEFAULT_MAX_ITERATIONS})`),
        timeoutMs: z
          .number().int().positive().max(MAX_TIMEOUT_MS).optional()
          .describe(
            `Wall-clock cap for this run in ms (default ${runTimeoutMs}). ` +
            "The MCP client's own call timeout must be >= this or the client aborts first.",
          ),
      },
    },
    async (args) => {
      const r = await runAgentHandler(runtime, args as RunAgentArgs, {
        maxIterations: DEFAULT_MAX_ITERATIONS,
        timeoutMs: runTimeoutMs,
      });
      return r as typeof r & { [k: string]: unknown }; // satisfy SDK CallToolResult index signature
    },
  );

  const { registerCodingAgentTool } = await import("../coding-agents/mcp.js");
  registerCodingAgentTool(server, runtime);

  const shutdown = async () => {
    try { await runtime.close(); } finally { process.exit(0); }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await server.connect(new StdioServerTransport());
  console.error(`tachi-agent MCP server ready · ${runtime.toolCount} downstream tools · exposes run_agent + run_coding_agent`);
}

// Only run when executed directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
