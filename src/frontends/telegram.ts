#!/usr/bin/env node
/**
 * Telegram front-end for tachi-agent.
 *
 * Long-polls the Telegram Bot API (no external dependencies — native fetch only)
 * and routes every allowed user's message through the singleton AgentRuntime.
 * Security: allowlist-only. Empty TELEGRAM_ALLOWED_USER_IDS → refuses to start.
 */
import { buildAgentFromEnv } from "../runtime.js";

// ─── Pure helpers (exported for unit tests — no I/O, no network) ───────────

/** Parse a comma-separated env value into a Set<number>. Blanks and NaN ignored. */
export function parseAllowedIds(env: string | undefined): Set<number> {
  if (!env) return new Set();
  const ids = new Set<number>();
  for (const part of env.split(",")) {
    const n = Number(part.trim());
    if (part.trim() !== "" && !Number.isNaN(n)) ids.add(n);
  }
  return ids;
}

/**
 * Returns true only when the allowlist is non-empty AND contains userId.
 * Fail-closed: empty allowlist → deny all.
 */
export function isAuthorized(userId: number | undefined, allowed: Set<number>): boolean {
  return allowed.size > 0 && userId !== undefined && allowed.has(userId);
}

/** Extract chatId, userId, text from a Telegram Update. Returns null for non-text updates. */
export function extractMessage(
  update: any,
): { chatId: number; userId: number; text: string } | null {
  const msg = update?.message;
  if (!msg || typeof msg.text !== "string") return null;
  const chatId: number = msg.chat?.id;
  const userId: number = msg.from?.id;
  if (chatId === undefined || userId === undefined) return null;
  return { chatId, userId, text: msg.text };
}

// ─── Telegram API helpers ───────────────────────────────────────────────────

const BASE = (token: string) => `https://api.telegram.org/bot${token}`;

/** Long-poll for updates; offset excludes already-seen update IDs. */
export async function getUpdates(
  token: string,
  offset: number,
  signal?: AbortSignal,
): Promise<any[]> {
  const res = await fetch(`${BASE(token)}/getUpdates`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ offset, timeout: 30 }),
    signal,
  });
  const data = (await res.json()) as { ok: boolean; result: any[] };
  return data.result ?? [];
}

/** Send a plain-text message to a chat. */
export async function sendMessage(token: string, chatId: number, text: string): Promise<void> {
  await fetch(`${BASE(token)}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error("TELEGRAM_BOT_TOKEN is required");
    process.exit(1);
  }

  const allowed = parseAllowedIds(process.env.TELEGRAM_ALLOWED_USER_IDS);
  if (allowed.size === 0) {
    console.error("Refusing to start without TELEGRAM_ALLOWED_USER_IDS");
    process.exit(1);
  }

  // Build singleton runtime — connects MCP servers once, reused for every message.
  const runtime = await buildAgentFromEnv();
  console.error(`tachi-agent Telegram bot ready · ${runtime.toolCount} downstream tools`);

  // Graceful shutdown.
  const shutdown = async () => {
    try { await runtime.close(); } finally { process.exit(0); }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Long-poll loop.
  let offset = 0;
  while (true) {
    let updates: any[];
    try {
      updates = await getUpdates(token, offset);
    } catch (e) {
      console.error("getUpdates error:", e);
      continue;
    }

    for (const update of updates) {
      // Always advance offset so we don't re-process this update.
      offset = update.update_id + 1;

      const msg = extractMessage(update);
      if (!msg) continue;

      if (!isAuthorized(msg.userId, allowed)) {
        console.error(`ignored unauthorized user ${msg.userId}`);
        continue;
      }

      // Handle each message independently so one error doesn't kill the loop.
      (async () => {
        try {
          await sendMessage(token, msg.chatId, "🤔 working…");
          const res = await runtime
            .orchestrator({ maxIterations: 8, timeoutMs: 90_000 })
            .run(msg.text);
          await sendMessage(token, msg.chatId, res.answer);
        } catch (e) {
          console.error("message handler error:", e);
          const errText = e instanceof Error ? e.message : String(e);
          await sendMessage(token, msg.chatId, `⚠️ Error: ${errText}`).catch(() => {});
        }
      })();
    }
  }
}

// Run only when executed directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
