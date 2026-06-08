/**
 * context-inspect.ts — a minimal, opt-in context inspector.
 *
 * Emits ONE JSONL line describing the context layers assembled for a model call,
 * written immediately before the agent invokes `Driver.chat`. It exists purely as
 * observability: it answers "what was in the prompt, why, and how big" without a
 * UI, a DB, OpenTelemetry, or any external dependency.
 *
 * Design rules (mirroring the rest of the orchestrator):
 *   - OFF BY DEFAULT. Nothing is computed or written unless explicitly enabled via
 *     `opts.enabled` or the `TACHI_CONTEXT_INSPECT` env var. The default agent path
 *     stays byte-identical — no file writes, no surprises.
 *   - NEVER throws. All token math + filesystem work is wrapped so instrumentation
 *     can never break a run (same philosophy as agent.ts `safe()`). Writing is
 *     strictly best-effort.
 */
import { mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChatMessage, AgentTool } from "./types.js";

/** Where the context-inspect JSONL files live, relative to process.cwd(). */
const OUTPUT_SUBDIR = join(".tachi", "context-inspect");
/** Per-layer/snippet character cap. */
const SNIPPET_MAX = 500;

/** One assembled context "layer" — a chunk of the prompt and why it's there. */
export interface ContextInspectLayer {
  name: "working" | "episodic" | "semantic" | "procedural" | "affective" | "system" | "tool" | "other";
  /** Honest, human-readable reason this layer was included. */
  reason: string;
  /** Optional relevance/ranking score — only when genuinely known. */
  score?: number;
  /** Rough token estimate: Math.ceil(text.length / 4). */
  tokenEstimate: number;
  /** Optional provenance (e.g. which memory provider supplied it). */
  source?: string;
  /** First SNIPPET_MAX chars of this layer's text. */
  contentSnippet: string;
}

/** A single context-inspect record (one model/driver chat call). */
export interface ContextInspectEvent {
  event: "context_inspect";
  sessionId?: string;
  turn?: number;
  /** ISO-8601 UTC timestamp. */
  timestamp: string;
  budgetTokens?: number;
  /** Sum of every layer's tokenEstimate. */
  totalEstimate: number;
  layers: ContextInspectLayer[];
  dropped?: Array<{ source?: string; reason: string; score?: number; tokenEstimate?: number }>;
}

/** Inputs needed to build/emit one event. */
export interface ContextInspectInput {
  messages: ChatMessage[];
  tools: AgentTool[];
  turn?: number;
  sessionId?: string;
  budgetTokens?: number;
  /**
   * Explicit on/off. When omitted, falls back to the TACHI_CONTEXT_INSPECT env var.
   * When neither is truthy the emitter is a complete no-op.
   */
  enabled?: boolean;
}

/** Rough token estimate — Math.ceil(text.length / 4). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Truncate to the first SNIPPET_MAX chars. */
export function snippet(text: string): string {
  return text.slice(0, SNIPPET_MAX);
}

/** True when TACHI_CONTEXT_INSPECT is set to any truthy-ish value (not unset / empty / "0" / "false"). */
export function isContextInspectEnvEnabled(): boolean {
  const v = process.env.TACHI_CONTEXT_INSPECT;
  if (!v) return false;
  const norm = v.trim().toLowerCase();
  return norm !== "" && norm !== "0" && norm !== "false" && norm !== "off" && norm !== "no";
}

/**
 * Classify one ChatMessage into a context layer. Kept honest about WHY each was
 * included rather than fabricating scores we don't have.
 */
function layerForMessage(msg: ChatMessage): ContextInspectLayer {
  const content = typeof msg.content === "string" ? msg.content : "";
  // The memory-in-loop "live memory" block is refreshed per step → working memory.
  if (msg.role === "system" && content.includes("Live memory")) {
    return { name: "working", reason: "live memory (refreshed per step)", source: "dokoro", tokenEstimate: estimateTokens(content), contentSnippet: snippet(content) };
  }
  // The base/system prompt — optionally carrying a recalled-memory section.
  if (msg.role === "system") {
    const carriesRecall = content.includes("Relevant prior context (memory)");
    return {
      // When recall is folded into the system prompt we still surface it as semantic
      // (persistent project memory) so the "why" is visible.
      name: carriesRecall ? "semantic" : "system",
      reason: carriesRecall ? "base system prompt + dokoro memory recall" : "base system prompt",
      ...(carriesRecall ? { source: "dokoro" } : {}),
      tokenEstimate: estimateTokens(content),
      contentSnippet: snippet(content),
    };
  }
  if (msg.role === "user") {
    return { name: "other", reason: "user task", tokenEstimate: estimateTokens(content), contentSnippet: snippet(content) };
  }
  if (msg.role === "assistant") {
    return { name: "episodic", reason: "prior assistant turn", tokenEstimate: estimateTokens(content), contentSnippet: snippet(content) };
  }
  // role === "tool"
  return { name: "tool", reason: "prior tool result", tokenEstimate: estimateTokens(content), contentSnippet: snippet(content) };
}

/** Assemble a ContextInspectEvent from the messages + tool definitions. Pure; no I/O. */
export function buildContextInspectEvent(input: ContextInspectInput): ContextInspectEvent {
  const layers: ContextInspectLayer[] = (input.messages ?? []).map(layerForMessage);

  // Summarize the tool definitions as a single 'tool' layer (their JSON is real prompt cost).
  if (input.tools && input.tools.length > 0) {
    const toolJson = JSON.stringify(input.tools);
    layers.push({
      name: "tool",
      reason: `${input.tools.length} tool definition${input.tools.length === 1 ? "" : "s"}`,
      tokenEstimate: estimateTokens(toolJson),
      contentSnippet: snippet(toolJson),
    });
  }

  const totalEstimate = layers.reduce((acc, l) => acc + l.tokenEstimate, 0);

  return {
    event: "context_inspect",
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.turn !== undefined ? { turn: input.turn } : {}),
    timestamp: new Date().toISOString(),
    ...(input.budgetTokens !== undefined ? { budgetTokens: input.budgetTokens } : {}),
    totalEstimate,
    layers,
  };
}

/**
 * Build and append a context-inspect event to `.tachi/context-inspect/YYYY-MM-DD.jsonl`.
 *
 * No-op unless enabled. Best-effort and exception-safe: ANY failure (event build,
 * directory creation, or file append) is swallowed so it can never break the run.
 */
export async function emitContextInspect(input: ContextInspectInput): Promise<void> {
  const enabled = input.enabled ?? isContextInspectEnvEnabled();
  if (!enabled) return;

  try {
    const event = buildContextInspectEvent(input);
    const date = event.timestamp.slice(0, 10); // YYYY-MM-DD (UTC, from the ISO timestamp)
    const dir = join(process.cwd(), OUTPUT_SUBDIR);
    await mkdir(dir, { recursive: true });
    // Best-effort, intentionally lock-free: concurrent writers sharing this cwd
    // (e.g. two CLI processes) can interleave lines in the shared YYYY-MM-DD.jsonl.
    // That's acceptable for observability — we deliberately do NOT add a lock or
    // PID-suffix the filename, because the date-based path is a contract with the
    // dokoro consumer.
    await appendFile(join(dir, `${date}.jsonl`), JSON.stringify(event) + "\n", "utf8");
  } catch {
    // Instrumentation must never break a run — swallow.
  }
}
