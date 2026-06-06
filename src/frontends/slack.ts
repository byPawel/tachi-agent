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
