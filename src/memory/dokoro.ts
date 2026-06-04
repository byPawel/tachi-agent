/**
 * DokoroMemory — persistent memory backed by dokoro tools on the connected host.
 * recall() pulls relevant prior context before reasoning; log() writes the outcome
 * back. Both degrade to no-ops if the dokoro tools aren't present, so the agent
 * still runs with tachibot-only.
 */
import type { Memory, ToolHost } from "../types.js";

export interface DokoroMemoryOptions {
  recallTool?: string; // default "dokoro_session_recall"
  logTool?: string;    // default "dokoro_session_log"
  limit?: number;      // recall result cap
}

export class DokoroMemory implements Memory {
  constructor(private readonly host: ToolHost, private readonly opts: DokoroMemoryOptions = {}) {}

  private has(name: string): boolean {
    return this.host.tools().some((t) => t.name === name);
  }

  async recall(task: string): Promise<string> {
    const tool = this.opts.recallTool ?? "dokoro_session_recall";
    if (!this.has(tool)) return "";
    try {
      return await this.host.call(tool, { query: task, limit: this.opts.limit ?? 5 });
    } catch {
      return "";
    }
  }

  async log(entry: { task: string; result: string }): Promise<void> {
    const tool = this.opts.logTool ?? "dokoro_session_log";
    if (!this.has(tool)) return;
    try {
      await this.host.call(tool, {
        type: "decision",
        content: `Task: ${entry.task}\n\nResult: ${entry.result}`,
      });
    } catch {
      /* best-effort; never fail the run on a logging error */
    }
  }
}
