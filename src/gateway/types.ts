import type { AgentEvent, RunResult } from "../types.js";

export type RunStatus = "running" | "done" | "error" | "aborted";

/** Everything streamed to an SSE client: the agent's own events plus transport events. */
export type GatewayEvent =
  | AgentEvent
  | { type: "error"; message: string }
  | { type: "heartbeat" };

/** One buffered event tagged with its durable, monotonic per-run sequence number. */
export interface SeqEvent {
  /** Monotonic per-run sequence (1-based, never reused). Becomes the SSE `id:`. */
  seq: number;
  event: GatewayEvent;
}

export interface RunRecord {
  id: string;
  tenant: string;
  task: string;
  status: RunStatus;
  /**
   * Bounded ring buffer of the most-recent events, each tagged with a durable
   * monotonic `seq` (the SSE `id:`). Older entries are evicted past the cap;
   * `eventsAfter`/`minSeq` on the registry drive Last-Event-ID replay.
   */
  events: SeqEvent[];
  /** Next seq to assign (so seq survives ring eviction). Starts at 0; first event is 1. */
  nextSeq: number;
  result?: RunResult;
  error?: string;
  controller: AbortController;
}
