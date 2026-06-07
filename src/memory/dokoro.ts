/**
 * DokoroMemory — the tachibot↔dokoro bridge's memory half.
 *
 * recall() pulls relevant prior context before reasoning; log() persists the
 * outcome AFTER. Both degrade to no-ops if dokoro isn't connected.
 *
 * The real round-trip (verified against dokoro v1):
 *  - log()    → `…session_summary_add` writes to the `conversation_summaries` table.
 *  - recall() → `…session_recall` READS that same table. (session_log writes a
 *    different store that recall never reads, which is why it silently "lost" memory.)
 *  Tools arrive double-prefixed (`dokoro_dokoro_session_recall`) and declare
 *  `additionalProperties:false`, so we DISCOVER by suffix and FILTER args to schema.
 */
import type { Memory, ToolHost, AgentTool } from "../types.js";

export interface DokoroMemoryOptions {
  /** Namespace prefix of the memory server (default "dokoro_"). */
  serverPrefix?: string;
  /** Stable session id grouping this agent's summaries (default: per-day). */
  sessionId?: string;
  /** Recorded with each summary (e.g. the driver/model name). */
  aiModel?: string;
  /** recall result cap. */
  limit?: number;
}

/**
 * Keep only candidate keys that exist in the tool's JSON-schema `properties`
 * (and are defined). Tools with `additionalProperties:false` reject anything else.
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
  private readonly sessionId: string;
  private readonly aiModel: string;

  constructor(private readonly host: ToolHost, private readonly opts: DokoroMemoryOptions = {}) {
    this.prefix = opts.serverPrefix ?? "dokoro_";
    this.sessionId = opts.sessionId ?? `tachi-agent-${new Date().toISOString().slice(0, 10)}`;
    this.aiModel = opts.aiModel ?? "tachi-agent";
  }

  /** Find a dokoro tool by suffix, preferring the dokoro namespace. */
  private find(suffix: RegExp): AgentTool | undefined {
    const tools = this.host.tools();
    return (
      tools.find((t) => t.name.startsWith(this.prefix) && suffix.test(t.name)) ??
      tools.find((t) => suffix.test(t.name))
    );
  }

  async recall(task: string, signal?: AbortSignal): Promise<string> {
    const tool = this.find(/session_recall$/);
    if (!tool) return "";
    const args = pickSchemaArgs(tool.parameters, { query: task, limit: this.opts.limit ?? 5, session_id: this.sessionId });
    try {
      const out = await this.host.call(tool.name, args, signal);
      return out?.includes("no past sessions") ? "" : out;
    } catch {
      return "";
    }
  }

  async log(entry: { task: string; result: string }, signal?: AbortSignal): Promise<void> {
    // session_summary_add → conversation_summaries (the table recall reads).
    const tool = this.find(/session_summary_add$/);
    if (!tool) return;
    const args = pickSchemaArgs(tool.parameters, {
      session_id: this.sessionId,
      ai_model: this.aiModel,
      summary: `Task: ${entry.task}\n\nResult: ${entry.result}`,
      key_topics: [],
    });
    try {
      await this.host.call(tool.name, args, signal);
    } catch {
      /* best-effort; never fail the run on a logging error */
    }
  }

  /**
   * Working-memory note → dokoro `shared_note_append` (append-only blackboard,
   * agent-tagged, WAL-safe). No-op if the tool isn't connected/allowlisted.
   */
  async note(entry: { task: string; note: string }, signal?: AbortSignal): Promise<void> {
    const tool = this.find(/shared_note_append$/);
    if (!tool) return;
    const args = pickSchemaArgs(tool.parameters, {
      agent_id: this.aiModel,
      content: entry.note,
      note_type: "scratch",
      metadata: { session_id: this.sessionId, task: entry.task },
    });
    try {
      await this.host.call(tool.name, args, signal);
    } catch {
      /* best-effort; never fail the run on a note write */
    }
  }
}
