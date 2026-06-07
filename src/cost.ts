/**
 * Rough per-call cost estimates for the cloud tools this agent routes to.
 * We do NOT meter tokens (MCP returns only text), so these are flat per-call
 * estimates by tool family — enough to surface "this run cost ~$X". Memory /
 * local tools are free (0). Extend by adding a row here.
 */
import type { RunResult } from "./types.js";

export const TOOL_COST_USD: Record<string, number> = {
  // tachibot multi-model / cloud tools (fan-out jury is priciest)
  tachibot_jury: 0.05,
  tachibot_grok_search: 0.01,
  tachibot_perplexity_ask: 0.01,
  tachibot_gemini_judge: 0.02,
  tachibot_openai_reason: 0.02,
  // dokoro memory tools — local, free
  dokoro_dokoro_session_recall: 0,
  dokoro_dokoro_session_summary_add: 0,
  dokoro_dokoro_workspace_status: 0,
};

/** Default for an unrecognised tool: assume a small cloud call rather than free. */
const DEFAULT_TOOL_COST_USD = 0.01;

function costForTool(name: string): number {
  // Object.hasOwn (not `in`) so a tool named like an inherited prototype key
  // (e.g. "toString") doesn't resolve to a function → NaN → a poisoned run sum.
  if (Object.hasOwn(TOOL_COST_USD, name)) return TOOL_COST_USD[name];
  // dokoro/local namespaces are free; everything else assumed a small cloud call.
  if (name.startsWith("dokoro_")) return 0;
  return DEFAULT_TOOL_COST_USD;
}

/** Sum the rough USD cost over a run's tool calls. Never returns NaN. */
export function estimateCost(toolCalls: RunResult["toolCalls"]): number {
  const total = toolCalls.reduce((sum, tc) => sum + costForTool(tc.name), 0);
  return Number.isFinite(total) ? total : 0;
}
