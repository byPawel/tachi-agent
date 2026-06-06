#!/usr/bin/env node
/**
 * Slack front-end for tachi-agent.
 *
 * Connects over Socket Mode (no public URL — fits the local-first thesis) and
 * routes every allowed user's DM / @-mention through the singleton AgentRuntime.
 * Streams progress by editing the "working…" message, then edits it into the
 * final answer (Slack mrkdwn). Security: allowlist-only, fail-closed.
 */
import { buildAgentFromEnv } from "../runtime.js";
import type { AgentEvent } from "../types.js";

// ─── Pure helpers (exported for unit tests — no I/O, no network) ───────────

/** Parse a comma-separated env value into a Set<string> of Slack user IDs. Blanks ignored. */
export function parseAllowedSlackIds(env: string | undefined): Set<string> {
  if (!env) return new Set();
  const ids = new Set<string>();
  for (const part of env.split(",")) {
    const id = part.trim();
    if (id !== "") ids.add(id);
  }
  return ids;
}

/** Fail-closed: empty allowlist → deny all. */
export function isSlackAuthorized(userId: string | undefined, allowed: Set<string>): boolean {
  return allowed.size > 0 && userId !== undefined && allowed.has(userId);
}

/**
 * Extract { channel, userId, text } from a Slack event (payload.event).
 * Accepts plain `message` and `app_mention` events from a real user; returns
 * null for bot echoes (bot_id), message subtypes (edits/joins), non-text, or
 * any other event type. Leading `<@BOT>` mentions are stripped.
 */
export function extractSlackMessage(
  event: any,
): { channel: string; userId: string; text: string } | null {
  if (!event) return null;
  if (event.type !== "message" && event.type !== "app_mention") return null;
  if (event.bot_id || event.subtype) return null; // drop bot echoes + edits/joins
  const channel: string | undefined = event.channel;
  const userId: string | undefined = event.user;
  if (typeof event.text !== "string" || channel === undefined || userId === undefined) return null;
  const text = event.text.replace(/^\s*<@[^>]+>\s*/, "").trim(); // strip a leading @-mention
  if (text === "") return null;
  return { channel, userId, text };
}

/**
 * Convert the model's standard Markdown to Slack "mrkdwn":
 * `**bold**` → `*bold*`, `### heading` → `*heading*`, `[t](u)` → `<u|t>`.
 */
export function toSlackMrkdwn(md: string): string {
  return md
    .replace(/\*\*(.+?)\*\*/gs, "*$1*")                     // **bold** → *bold*
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")                   // # heading → *heading*
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "<$2|$1>"); // [t](u) → <u|t>
}

/** Emoji for a (namespaced) tool name — used in the live Slack step tracker. */
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
