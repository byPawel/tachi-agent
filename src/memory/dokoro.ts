/**
 * DokoroMemory — the tachibot↔dokoro bridge's memory half.
 *
 * recall() pulls relevant prior context before reasoning; log() writes the
 * outcome back. Both degrade to no-ops if dokoro isn't connected, so the agent
 * still runs tachibot-only.
 *
 * Robustness (why this isn't just `host.call("dokoro_session_recall", …)`):
 *  - The real dokoro server is devlog-mcp, whose tools are `devlog_*`, so under
 *    the `${server}_${tool}` namespacing they arrive as `dokoro_devlog_session_recall`,
 *    `dokoro_devlog_session_log`, … → we DISCOVER by suffix, not a hardcoded name.
 *  - Those tools declare `additionalProperties:false` with specific arg names
 *    (e.g. session_log wants `entry`, not `content`) → we FILTER our candidate
 *    args down to the tool's actual JSON-schema properties before calling.
 */
import type { Memory, ToolHost, AgentTool } from "../types.js";

export interface DokoroMemoryOptions {
  /** Namespace prefix of the memory server (default "dokoro_"). */
  serverPrefix?: string;
  /** Explicit namespaced tool name overrides (skip discovery). */
  recallTool?: string;
  logTool?: string;
  /** recall result cap. */
  limit?: number;
}

/**
 * Keep only candidate keys that exist in the tool's JSON-schema `properties`
 * (and are defined). Tools with `additionalProperties:false` reject anything
 * else; tools with no declared properties get the candidate as-is.
 */
export function pickSchemaArgs(
  parameters: Record<string, unknown> | undefined,
  candidate: Record<string, unknown>,
): Record<string, unknown> {
  const props = (parameters as { properties?: Record<string, unknown> } | undefined)?.properties;
  if (!props || typeof props !== "object") return { ...candidate };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(candidate)) {
    if (v !== undefined && k in props) out[k] = v;
  }
  return out;
}

export class DokoroMemory implements Memory {
  private readonly prefix: string;
  constructor(private readonly host: ToolHost, private readonly opts: DokoroMemoryOptions = {}) {
    this.prefix = opts.serverPrefix ?? "dokoro_";
  }

  /** Find a dokoro tool by explicit name, else by suffix — preferring the dokoro namespace. */
  private find(explicit: string | undefined, suffix: RegExp): AgentTool | undefined {
    const tools = this.host.tools();
    if (explicit) return tools.find((t) => t.name === explicit);
    return (
      tools.find((t) => t.name.startsWith(this.prefix) && suffix.test(t.name)) ??
      tools.find((t) => suffix.test(t.name))
    );
  }

  async recall(task: string): Promise<string> {
    const tool = this.find(this.opts.recallTool, /session_recall$/);
    if (!tool) return "";
    const args = pickSchemaArgs(tool.parameters, { query: task, limit: this.opts.limit ?? 5 });
    try {
      return await this.host.call(tool.name, args);
    } catch {
      return "";
    }
  }

  async log(entry: { task: string; result: string }): Promise<void> {
    const tool = this.find(this.opts.logTool, /session_log$/);
    if (!tool) return;
    // `entry` is the devlog_session_log arg name; `type` is its enum. pickSchemaArgs
    // drops whichever the connected tool doesn't actually declare.
    const args = pickSchemaArgs(tool.parameters, {
      entry: `Task: ${entry.task}\n\nResult: ${entry.result}`,
      type: "decision",
    });
    try {
      await this.host.call(tool.name, args);
    } catch {
      /* best-effort; never fail the run on a logging error */
    }
  }
}
