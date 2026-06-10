/**
 * Shared pure helpers for the chat front-ends (Telegram, Slack).
 * One source of truth for allowlist parsing, Markdown base conversion,
 * tool emoji, and progress-step formatting. No I/O, no network.
 */
import type { AgentEvent } from "../types.js";

/** Parse a comma-separated env value into a Set<string>. Blanks ignored; empty/unset → empty set (fail-closed). */
export function parseAllowSet(env: string | undefined): Set<string> {
  if (!env) return new Set();
  const ids = new Set<string>();
  for (const part of env.split(",")) {
    const id = part.trim();
    if (id !== "") ids.add(id);
  }
  return ids;
}

/** Shared Markdown base: `**bold**` → `*bold*`, `# heading` → `*heading*` (both Telegram legacy and Slack mrkdwn want this). */
export function mdBoldHeadings(md: string): string {
  return md
    .replace(/\*\*(.+?)\*\*/gs, "*$1*")
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*");
}

/** Emoji for a (namespaced) tool name — used in the live step trackers. */
export function toolEmoji(name: string): string {
  if (name.includes("jury")) return "⚖️";
  if (name.includes("council")) return "🏛️";
  if (name.includes("grok_search") || name.includes("search")) return "🔍";
  if (name.includes("perplexity") || name.includes("ask")) return "🔎";
  if (name.includes("judge")) return "🧑‍⚖️";
  if (name.includes("recall")) return "🧠";
  if (name.includes("log")) return "💾";
  if (name.includes("reason") || name.includes("think")) return "🤔";
  return "🔧";
}

/** One status line for a progress event, or null for events that don't render in step trackers. */
export function formatStepEvent(e: AgentEvent): string | null {
  if (e.type === "step") return `⚙️ step ${e.iteration}`;
  if (e.type === "assistant" && e.toolCalls.length)
    return e.toolCalls.map((c) => `${toolEmoji(c.name)} ${c.name}…`).join("\n");
  if (e.type === "tool-result") return `   ✅ ${e.name}`;
  return null;
}
