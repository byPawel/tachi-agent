/**
 * tachi-agent — core contracts (the pluggable seams).
 *
 * The orchestrator depends ONLY on these interfaces, never on a concrete model
 * or a concrete MCP transport. That is what makes it pluggable WITHOUT a plugin
 * framework: swap the Driver to change the brain (e.g. OpenClaw supplies its own),
 * swap/extend the ToolHost to change which MCP servers/tools are reachable.
 */

/** A tool the agent can call, namespaced `${server}_${tool}` (e.g. `dokoro_session_recall`). */
export interface AgentTool {
  /** Namespaced name: `${server}_${tool}`. */
  name: string;
  description: string;
  /** JSON Schema for the arguments (an MCP `inputSchema`). */
  parameters: Record<string, unknown>;
}

/** A tool call emitted by a Driver. `arguments` is already parsed to an object. */
export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Present on assistant turns that request tools. */
  toolCalls?: ToolCall[];
  /** Present on `tool` turns — which call this result answers. */
  toolCallId?: string;
}

export interface DriverResult {
  /** Final assistant text (empty when the turn is purely tool calls). */
  content: string;
  /** Tool calls requested this turn; empty array = the Driver is done. */
  toolCalls: ToolCall[];
}

/**
 * SEAM 1 — the reasoning engine. Default impl = local Qwen2.5 over Ollama.
 * OpenClaw / any other agent plugs in by implementing this (its own model/loop).
 */
export interface Driver {
  readonly name: string;
  chat(input: { messages: ChatMessage[]; tools: AgentTool[] }): Promise<DriverResult>;
}

/**
 * SEAM 2 — the tool surface. Default impl merges dokoro + tachibot MCP servers
 * with `${server}_${tool}` namespacing. Adding a server = config, not code.
 */
export interface ToolHost {
  /** All available tools across every connected server, namespaced. */
  tools(): AgentTool[];
  /** Dispatch a namespaced tool call; returns the tool's text result.
   *  `signal` (optional) aborts an in-flight call — the host also enforces its own timeout. */
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
}

/**
 * SEAM 3 (optional) — persistent memory. Default impl is backed by dokoro tools
 * on the ToolHost, but kept separate so the recall→reason→log loop is explicit
 * and testable, and so memory can be disabled or swapped independently.
 */
export interface Memory {
  recall(task: string, signal?: AbortSignal): Promise<string>;
  log(entry: { task: string; result: string }, signal?: AbortSignal): Promise<void>;
  /**
   * Optional working-memory write: a per-step scratchpad note during the ReAct
   * loop (used only in memory-in-loop mode). Implementations may omit it / no-op.
   * Default impl (DokoroMemory) appends to dokoro's shared working memory.
   */
  note?(entry: { task: string; note: string }, signal?: AbortSignal): Promise<void>;
}

/**
 * Streamed progress events. Front-ends (CLI, Telegram, Slack, Claude Code) render
 * these live instead of waiting for the final answer.
 */
export type AgentEvent =
  | { type: "step"; iteration: number }
  | { type: "assistant"; content: string; toolCalls: ToolCall[] }
  | { type: "tool-result"; name: string; result: string }
  | { type: "cost"; usd: number; calls: number }
  | { type: "final"; answer: string; haltedBy: RunResult["haltedBy"] };

export interface OrchestratorOptions {
  /** Hard stop on the ReAct loop. Default 10. */
  maxIterations?: number;
  /** Wall-clock budget for the whole run (ms). Default 120_000. Cloud tools cost money — see RunResult.costUsd. */
  timeoutMs?: number;
  /** Extra system-prompt guidance prepended to the agent's instructions. */
  systemPrompt?: string;
  /** Cooperative cancellation — abort to stop the agent between steps (e.g. a Slack "/stop" or Ctrl-C). */
  signal?: AbortSignal;
  /** Streaming hook — called as the run progresses, for live front-end output. */
  onEvent?: (event: AgentEvent) => void;
  /**
   * Opt-in working-memory mode. When true (and a Memory is present), the loop
   * refreshes recall each iteration and writes a per-step note via Memory.note,
   * instead of only the recall→log bookend. Default false — zero change for
   * existing callers (a small local model degrades with extra per-step tool calls).
   */
  memoryInLoop?: boolean;
}

export interface RunResult {
  answer: string;
  iterations: number;
  toolCalls: Array<{ name: string; args: Record<string, unknown>; result: string }>;
  haltedBy: "final-answer" | "max-iterations" | "timeout" | "aborted";
  /** Rough estimated USD spent on cloud tool calls this run (0 for purely local/memory tools). */
  costUsd: number;
}
