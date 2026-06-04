#!/usr/bin/env node
/**
 * Telegram front-end for tachi-agent.
 *
 * Long-polls the Telegram Bot API (no external dependencies — native fetch only)
 * and routes every allowed user's message through the singleton AgentRuntime.
 * Streams progress by EDITING the "working…" message as steps/tools fire, then
 * edits it into the Markdown-formatted final answer. Security: allowlist-only.
 */
import { buildAgentFromEnv } from "../runtime.js";
import type { AgentEvent } from "../types.js";

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

/** Fail-closed: empty allowlist → deny all. */
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

/**
 * Convert the model's standard Markdown to Telegram "Markdown" (legacy):
 * `**bold**` → `*bold*`, `### heading` → `*heading*`. Telegram legacy mode is
 * lenient about `(). -` etc.; a parse failure falls back to plain text.
 */
export function toTelegramMarkdown(md: string): string {
  return md
    .replace(/\*\*(.+?)\*\*/gs, "*$1*")       // **bold** → *bold*
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*");    // # heading → *heading*
}

/** Emoji for a (namespaced) tool name — used in the live Telegram step tracker. */
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

// ─── Telegram API helpers ───────────────────────────────────────────────────

const BASE = (token: string) => `https://api.telegram.org/bot${token}`;

export async function getUpdates(token: string, offset: number, signal?: AbortSignal): Promise<any[]> {
  const res = await fetch(`${BASE(token)}/getUpdates`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ offset, timeout: 30 }),
    signal,
  });
  const data = (await res.json()) as { ok: boolean; result: any[] };
  return data.result ?? [];
}

/** Send a message; returns its message_id (for later edits) or undefined. */
export async function sendMessage(
  token: string, chatId: number, text: string, parseMode?: "Markdown",
): Promise<number | undefined> {
  const res = await fetch(`${BASE(token)}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, ...(parseMode ? { parse_mode: parseMode } : {}) }),
  });
  const data = (await res.json()) as { ok: boolean; result?: { message_id: number } };
  return data.result?.message_id;
}

/** Edit a message; returns true if Telegram accepted it. */
export async function editMessage(
  token: string, chatId: number, messageId: number, text: string, parseMode?: "Markdown",
): Promise<boolean> {
  try {
    const res = await fetch(`${BASE(token)}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, ...(parseMode ? { parse_mode: parseMode } : {}) }),
    });
    const data = (await res.json()) as { ok: boolean };
    return data.ok === true;
  } catch {
    return false;
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) { console.error("TELEGRAM_BOT_TOKEN is required"); process.exit(1); }

  const allowed = parseAllowedIds(process.env.TELEGRAM_ALLOWED_USER_IDS);
  if (allowed.size === 0) { console.error("Refusing to start without TELEGRAM_ALLOWED_USER_IDS"); process.exit(1); }

  const runtime = await buildAgentFromEnv(); // singleton — reused for every message
  console.error(`tachi-agent Telegram bot ready · ${runtime.toolCount} downstream tools`);

  const shutdown = async () => { try { await runtime.close(); } finally { process.exit(0); } };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  let offset = 0;
  while (true) {
    let updates: any[];
    try { updates = await getUpdates(token, offset); }
    catch (e) { console.error("getUpdates error:", e); continue; }

    for (const update of updates) {
      offset = update.update_id + 1;
      const msg = extractMessage(update);
      if (!msg) continue;
      if (!isAuthorized(msg.userId, allowed)) { console.error(`ignored unauthorized user ${msg.userId}`); continue; }

      // Handle each message independently so one error can't kill the loop.
      void (async () => {
        const statusId = await sendMessage(token, msg.chatId, "🤔 working…");
        const steps: string[] = [];
        let lastEdit = 0;
        // Plain text (no parse_mode) — tool names contain underscores that would break
        // Telegram Markdown. Emoji render fine in plain text; the FINAL answer uses Markdown.
        const flush = () => {
          const now = Date.now();
          if (statusId === undefined || now - lastEdit < 1200) return; // throttle (Telegram edit rate limit)
          lastEdit = now;
          void editMessage(token, msg.chatId, statusId, `🤔 working…\n${steps.join("\n")}`);
        };
        const onEvent = (e: AgentEvent) => {
          if (e.type === "step") steps.push(`⚙️ step ${e.iteration}`);
          else if (e.type === "assistant" && e.toolCalls.length)
            for (const c of e.toolCalls) steps.push(`${toolEmoji(c.name)} ${c.name}…`);
          else if (e.type === "tool-result") steps.push(`   ✅ ${e.name}`);
          else return;
          flush();
        };
        try {
          const res = await runtime.orchestrator({ maxIterations: 10, timeoutMs: 180_000, onEvent }).run(msg.text);
          const answer = res.answer.startsWith("[halted")
            ? `⏱ Stopped early (${res.haltedBy}). A deep council on a local model can take a while — try a simpler ask, or send it again.`
            : res.answer;
          const formatted = toTelegramMarkdown(answer) || "(no answer produced)";
          // Edit the status bubble into the formatted answer; fall back to plain on parse failure.
          const edited = statusId !== undefined && (await editMessage(token, msg.chatId, statusId, formatted, "Markdown"));
          if (!edited) await sendMessage(token, msg.chatId, res.answer); // plain fallback
        } catch (e) {
          const errText = e instanceof Error ? e.message : String(e);
          if (statusId !== undefined) await editMessage(token, msg.chatId, statusId, `⚠️ Error: ${errText}`);
          else await sendMessage(token, msg.chatId, `⚠️ Error: ${errText}`).catch(() => {});
        }
      })();
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
