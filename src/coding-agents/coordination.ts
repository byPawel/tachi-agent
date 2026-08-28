import type { AgentTool } from "../types.js";

export interface CoordinationHost {
  internalTools(): AgentTool[];
  callInternal(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
}

export interface CodingCoordinationContext {
  agentId: string;
  sessionId: string;
  task: string;
  cwd: string;
  files?: string[];
  signal?: AbortSignal;
}

function find(host: CoordinationHost, suffix: RegExp): AgentTool | undefined {
  return host.internalTools().find((tool) => tool.name.startsWith("dokoro_") && suffix.test(tool.name));
}

async function call(
  host: CoordinationHost,
  suffix: RegExp,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  const tool = find(host, suffix);
  if (!tool) return "";
  return host.callInternal(tool.name, args, signal);
}

/** Announce the worker and atomically acquire its declared file leases. */
export async function beginCodingCoordination(
  host: CoordinationHost,
  context: CodingCoordinationContext,
): Promise<{ claimed: boolean }> {
  await call(host, /presence_ping$/, {
    agent_id: context.agentId,
    session_id: context.sessionId,
    status: "active",
    current_focus: context.task.slice(0, 1_000),
  }, context.signal).catch(() => "");

  if (!context.files?.length) return { claimed: false };
  const output = await call(host, /file_claim$/, {
    paths: context.files,
    agent_id: context.agentId,
    session_id: context.sessionId,
    intent: context.task.slice(0, 2_000),
    root: context.cwd,
    ttl_seconds: 3_600,
  }, context.signal);
  if (/CONFLICT\s+—\s+NOTHING was claimed/i.test(output)) {
    throw new Error(`Dokoro file-claim conflict:\n${output}`);
  }
  return { claimed: Boolean(output) };
}

/**
 * Persist a directed handoff for Claude Code and release any leases. All writes
 * are best-effort: the synchronous MCP result remains the authoritative report.
 */
export async function finishCodingCoordination(
  host: CoordinationHost,
  context: CodingCoordinationContext,
  report: { summary: string; openItems?: string[]; targetAgent?: string; writeHandoff?: boolean },
  claimed: boolean,
): Promise<void> {
  if (report.writeHandoff !== false) {
    await call(host, /handoff_write$/, {
      from_agent: context.agentId,
      to_agent: report.targetAgent ?? "claude-code",
      session_id: context.sessionId,
      summary: report.summary.slice(0, 20_000),
      open_items: report.openItems ?? [],
    }, context.signal).catch(() => "");
  }

  if (claimed && context.files?.length) {
    await call(host, /file_release$/, {
      paths: context.files,
      agent_id: context.agentId,
      root: context.cwd,
    }, context.signal).catch(() => "");
  }
  await call(host, /presence_ping$/, {
    agent_id: context.agentId,
    session_id: context.sessionId,
    status: "idle",
    current_focus: "handoff sent to Claude Code",
  }, context.signal).catch(() => "");
}
