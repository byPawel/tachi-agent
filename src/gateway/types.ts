import type { AgentEvent, RunResult } from "../types.js";

export type RunStatus = "running" | "done" | "error" | "aborted";

/** Everything streamed to an SSE client: the agent's own events plus transport events. */
export type GatewayEvent =
  | AgentEvent
  | { type: "error"; message: string }
  | { type: "heartbeat" };

export interface RunRecord {
  id: string;
  tenant: string;
  task: string;
  status: RunStatus;
  /** Append-only event log; the SSE `id:` is the array index (enables replay). */
  events: GatewayEvent[];
  result?: RunResult;
  error?: string;
  controller: AbortController;
}
