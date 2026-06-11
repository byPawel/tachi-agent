#!/usr/bin/env node
/**
 * Telegram front-end for tachi-agent.
 *
 * Long-polls the Telegram Bot API (no external dependencies — native fetch only)
 * and routes every allowed user's message through the singleton AgentRuntime.
 * Streams progress by EDITING the "working…" message as steps/tools fire, then
 * edits it into the Markdown-formatted final answer. Security: allowlist-only.
 *
 * Command routing: messages starting with "/" are dispatched through the shared
 * handleChatLine layer (chat-commands.ts). Plain messages run through the agent
 * with the session's resolveRunOptions spread in. Per-chat sessions are capped at
 * 200 entries with LRU eviction based on lastSeen timestamp.
 */
import { createUnifiedClient } from "../client/unified.js";
import type { AgentEvent } from "../types.js";
import { parseAllowSet, mdBoldHeadings, toolEmoji as _toolEmoji, formatStepEvent } from "./shared.js";
import { handleChatLine, resolveRunOptions, type ChatSession, type ChatDeps } from "../chat-commands.js";
import { loadSkills } from "../skills.js";
import { taskAdd, taskList, taskShow } from "../cli-commands.js";
import { loadUserEnv } from "../env-bootstrap.js";

// ─── Pure helpers (exported for unit tests — no I/O, no network) ───────────

/** Parse a comma-separated env value into a Set<number>. Blanks and NaN ignored. */
export function parseAllowedIds(env: string | undefined): Set<number> {
  const ids = new Set<number>();
  for (const id of parseAllowSet(env)) {
    const n = Number(id);
    if (!Number.isNaN(n)) ids.add(n);
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
  return mdBoldHeadings(md);
}

/** Emoji for a (namespaced) tool name — used in the live Telegram step tracker. */
export { _toolEmoji as toolEmoji };

/**
 * Truncate text to Telegram's 4096-character message limit.
 * If truncation is needed, appends "…[truncated]" within the limit.
 */
export function truncateForTelegram(text: string): string {
  const LIMIT = 4096;
  if (text.length <= LIMIT) return text;
  const MARKER = "…[truncated]";
  return text.slice(0, LIMIT - MARKER.length) + MARKER;
}

// ─── Session management ─────────────────────────────────────────────────────

/** Internal session shape: ChatSession + lastSeen timestamp for LRU eviction. */
export type TelegramSession = ChatSession & { lastSeen: number };

const SESSION_CAP = 200;

/**
 * Get or create the per-chat session. Tracks lastSeen for LRU eviction.
 * When the map would exceed SESSION_CAP entries, the least-recently-used
 * entry is evicted before inserting the new one.
 *
 * @param sessions  The shared session map (mutated in-place).
 * @param chatId    Telegram chat id.
 * @param now       Injectable clock — `() => Date.now()`. Defaults to real clock.
 */
export function getSession(
  sessions: Map<number, TelegramSession>,
  chatId: number,
  now: () => number = Date.now,
): ChatSession {
  const ts = now();

  if (sessions.has(chatId)) {
    const existing = sessions.get(chatId)!;
    existing.lastSeen = ts;
    return existing;
  }

  // Evict LRU when at cap
  if (sessions.size >= SESSION_CAP) {
    let lruKey: number | undefined;
    let lruTime = Infinity;
    for (const [id, s] of sessions) {
      if (s.lastSeen < lruTime) {
        lruTime = s.lastSeen;
        lruKey = id;
      }
    }
    if (lruKey !== undefined) sessions.delete(lruKey);
  }

  const session: TelegramSession = { lastSeen: ts };
  sessions.set(chatId, session);
  return session;
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
  await loadUserEnv(); // ~/.tachi/.env as defaults — real env vars win
  const tokenRaw = process.env.TELEGRAM_BOT_TOKEN;
  if (!tokenRaw) { console.error("TELEGRAM_BOT_TOKEN is required"); process.exit(1); }
  const token: string = tokenRaw;

  const allowed = parseAllowedIds(process.env.TELEGRAM_ALLOWED_USER_IDS);
  if (allowed.size === 0) { console.error("Refusing to start without TELEGRAM_ALLOWED_USER_IDS"); process.exit(1); }

  // Local-or-daemon: with TACHI_DAEMON_URL set this attaches to the daemon; unset, it
  // builds the in-process runtime (identical to before). `client.run` returns the same
  // RunResult and streams the same AgentEvents, so the loop below is unchanged.
  const client = await createUnifiedClient(process.env);
  console.error(
    process.env.TACHI_DAEMON_URL
      ? `tachi-agent Telegram bot ready · attached to daemon ${process.env.TACHI_DAEMON_URL}`
      : `tachi-agent Telegram bot ready · local runtime`,
  );

  // Skills loaded once at startup — shared across all chats.
  const skills = await loadSkills();

  // Task fns bound only when daemon env vars are present.
  const hasDaemon = !!(process.env.TACHI_DAEMON_URL && process.env.GATEWAY_TOKEN);
  const env = process.env as Record<string, string | undefined>;
  const fetchImpl = fetch;

  // Build string-collector wrappers: each fn collects stdout lines into a string.
  function makeTaskAdd(): ((text: string, opts: { driver?: string }) => Promise<string>) | null {
    if (!hasDaemon) return null;
    return async (text, opts) => {
      const lines: string[] = [];
      await taskAdd({ env, fetchImpl, stdout: (l) => lines.push(l) }, text, opts);
      return lines.join("\n");
    };
  }

  function makeTaskList(): (() => Promise<string>) | null {
    if (!hasDaemon) return null;
    return async () => {
      const lines: string[] = [];
      await taskList({ env, fetchImpl, stdout: (l) => lines.push(l) });
      return lines.join("\n");
    };
  }

  function makeTaskShow(): ((id: string) => Promise<string>) | null {
    if (!hasDaemon) return null;
    return async (id) => {
      const lines: string[] = [];
      await taskShow({ env, fetchImpl, stdout: (l) => lines.push(l) }, id);
      return lines.join("\n");
    };
  }

  // Per-chat session map — capped at 200 entries with LRU eviction.
  const sessions = new Map<number, TelegramSession>();

  const shutdown = async () => { try { await client.close(); } finally { process.exit(0); } };
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

      // Capture non-null values before the async closure to satisfy strict TS.
      const chatId = msg.chatId;
      const msgText = msg.text;

      // Handle each message independently so one error can't kill the loop.
      void (async () => {
        const session = getSession(sessions, chatId);

        // ── Command routing: "/" messages go through handleChatLine ──────────
        if (msgText.startsWith("/")) {
          const deps: ChatDeps = {
            session,
            skills,
            listTools: () => "(daemon mode — tool list unavailable)",
            modelName: () => "(daemon mode — model unavailable)",
            mode: process.env.TACHI_DAEMON_URL ? `daemon ${process.env.TACHI_DAEMON_URL}` : "local",
            taskAdd: makeTaskAdd(),
            taskList: makeTaskList(),
            taskShow: makeTaskShow(),
            scheduleList: null, // scheduleList not yet exported from cli-commands.ts
          };

          const action = await handleChatLine(msgText, deps);

          switch (action.kind) {
            case "exit":
              await sendMessage(token, chatId, "n/a in Telegram");
              return;

            case "reply": {
              const replyText = truncateForTelegram(action.text || "(empty)");
              await sendMessage(token, chatId, replyText);
              return;
            }

            case "run":
              // Fall through to agent run below, echoing the rewritten task in the status message.
              await runWithSession(action.text, { echoText: action.text });
              return;

            case "message":
              // Command produced a plain message — run it through the agent.
              await runWithSession(action.text, {});
              return;
          }
        } else {
          // ── Plain message: run through agent with session options ──────────
          await runWithSession(msgText, {});
        }

        async function runWithSession(
          taskText: string,
          opts: { echoText?: string },
        ): Promise<void> {
          const statusId = await sendMessage(token, chatId, "🤔 working…");
          const steps: string[] = [];
          // If this is a /run rewrite, echo the rewritten task in the status message.
          if (opts.echoText !== undefined) {
            steps.push(`→ ${opts.echoText}`);
          }
          let lastEdit = 0;
          // Plain text (no parse_mode) — tool names contain underscores that would break
          // Telegram Markdown. Emoji render fine in plain text; the FINAL answer uses Markdown.
          const flush = () => {
            const now = Date.now();
            if (statusId === undefined || now - lastEdit < 1200) return; // throttle (Telegram edit rate limit)
            lastEdit = now;
            const body = steps.length > 0 ? `\n${steps.join("\n")}` : "";
            void editMessage(token, chatId, statusId, `🤔 working…${body}`);
          };
          const onEvent = (e: AgentEvent) => {
            const line = formatStepEvent(e);
            if (line === null) return;
            steps.push(line);
            flush();
          };
          try {
            const runOpts = resolveRunOptions(session);
            const res = await client.run(taskText, { onEvent, maxIterations: 10, timeoutMs: 180_000, ...runOpts });
            const answer = res.answer.startsWith("[halted")
              ? `⏱ Stopped early (${res.haltedBy}). A deep council on a local model can take a while — try a simpler ask, or send it again.`
              : res.answer;
            const formatted = toTelegramMarkdown(answer) || "(no answer produced)";
            // Edit the status bubble into the formatted answer; fall back to plain on parse failure.
            const truncated = truncateForTelegram(formatted);
            const edited = statusId !== undefined && (await editMessage(token, chatId, statusId, truncated, "Markdown"));
            if (!edited) await sendMessage(token, chatId, truncateForTelegram(res.answer)); // plain fallback
          } catch (e) {
            const errText = e instanceof Error ? e.message : String(e);
            if (statusId !== undefined) await editMessage(token, chatId, statusId, `⚠️ Error: ${errText}`);
            else await sendMessage(token, chatId, `⚠️ Error: ${errText}`).catch(() => {});
          }
        }
      })();
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
