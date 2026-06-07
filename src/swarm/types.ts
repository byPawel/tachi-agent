// src/swarm/types.ts
import type { RunResult, AgentEvent } from "../types.js";

export interface SwarmRole {
  /** Short label, e.g. "implementer". */
  name: string;
  /** Role lens prepended as the agent's system prompt. */
  systemPrompt: string;
  /** Registered driver name (getDriver); omitted → the swarm's default driver. */
  driver?: string;
  /** If true, a missing answer from this role triggers a quorum warning. */
  critical?: boolean;
}

export interface SwarmMember {
  role: string;
  answer: string;
  haltedBy: RunResult["haltedBy"];
  costUsd: number;
}

export interface SwarmResult {
  /** The synthesizer's merged answer. */
  answer: string;
  /** Each member's individual result (in role order). */
  members: SwarmMember[];
  /** Non-fatal quorum/degradation warnings (e.g. a critical role produced no answer). */
  warnings?: string[];
}

/** Minimal agent surface a swarm member/synthesizer needs — injectable for tests. */
export interface SwarmAgent {
  run(task: string, opts: { onEvent?: (e: AgentEvent) => void; signal?: AbortSignal }): Promise<RunResult>;
}

export interface SwarmDeps {
  /** Build the agent for a given role. Default wraps createOrchestrator. */
  makeAgent: (role: SwarmRole) => SwarmAgent;
}
