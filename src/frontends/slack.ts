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

/** Slack rejects very long `text`; truncate so a long answer still sends. */
export const SLACK_TEXT_LIMIT = 39000;

/** Truncate text to fit Slack's message limit, appending a marker when cut. */
export function truncateForSlack(text: string): string {
  if (text.length <= SLACK_TEXT_LIMIT) return text;
  return text.slice(0, SLACK_TEXT_LIMIT - 20) + "\n…[truncated]";
}

/**
 * Convert the model's standard Markdown to Slack "mrkdwn":
 * `**bold**` → `*bold*`, `### heading` → `*heading*`, `[t](u)` → `<u|t>`.
 * Literal `<`/`>` in the body are escaped FIRST so they can't inject Slack
 * tags; the link rule then emits its own `<url|text>` tags afterward. `&` is
 * left untouched to avoid corrupting `&`-containing URLs/query strings.
 */
export function toSlackMrkdwn(md: string): string {
  return md
    .replace(/</g, "&lt;")                                  // escape literal angle brackets first
    .replace(/>/g, "&gt;")
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

// ─── Slack Web API helpers ──────────────────────────────────────────────────

const SLACK_API = "https://slack.com/api";

/** Post a message; returns its `ts` (used for later edits) or undefined. */
export async function postMessage(
  token: string, channel: string, text: string,
): Promise<string | undefined> {
  const res = await fetch(`${SLACK_API}/chat.postMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ channel, text }),
  });
  const data = (await res.json()) as { ok: boolean; ts?: string };
  return data.ok ? data.ts : undefined;
}

/** Edit a message by `ts`; returns true if Slack accepted it. */
export async function updateMessage(
  token: string, channel: string, ts: string, text: string,
): Promise<boolean> {
  try {
    const res = await fetch(`${SLACK_API}/chat.update`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ channel, ts, text }),
    });
    const data = (await res.json()) as { ok: boolean };
    return data.ok === true;
  } catch {
    return false;
  }
}

/** Open a Socket Mode connection; returns the wss URL to connect to. */
export async function openSocketModeUrl(appToken: string): Promise<string> {
  const res = await fetch(`${SLACK_API}/apps.connections.open`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${appToken}` },
  });
  const data = (await res.json()) as { ok: boolean; url?: string; error?: string };
  if (!data.ok || !data.url) throw new Error(`apps.connections.open failed: ${data.error ?? "unknown"}`);
  return data.url;
}

// ─── Main ───────────────────────────────────────────────────────────────────

// Node ≥22 exposes WebSocket as a global; @types/node 22.x does not yet include
// the declaration, so we declare it minimally here. Requires Node ≥22 at runtime.
declare const WebSocket: {
  new (url: string): {
    send(data: string): void;
    close(): void;
    addEventListener(type: "message", listener: (ev: { data: unknown }) => void): void;
    addEventListener(type: "close", listener: () => void): void;
    addEventListener(type: "error", listener: () => void): void;
  };
};

/** Acknowledge a Socket Mode envelope so Slack stops re-delivering it. */
function ack(ws: InstanceType<typeof WebSocket>, envelopeId: string): void {
  ws.send(JSON.stringify({ envelope_id: envelopeId }));
}

async function handleEvent(
  runtime: Awaited<ReturnType<typeof buildAgentFromEnv>>,
  token: string,
  msg: { channel: string; userId: string; text: string },
): Promise<void> {
  const statusTs = await postMessage(token, msg.channel, "🤔 working…");
  const steps: string[] = [];
  let lastEdit = 0;
  const flush = () => {
    const now = Date.now();
    if (statusTs === undefined || now - lastEdit < 1200) return; // throttle Slack edits
    lastEdit = now;
    void updateMessage(token, msg.channel, statusTs, `🤔 working…\n${steps.join("\n")}`);
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
    const formatted = truncateForSlack(toSlackMrkdwn(answer) || "(no answer produced)");
    const edited = statusTs !== undefined && (await updateMessage(token, msg.channel, statusTs, formatted));
    if (!edited) await postMessage(token, msg.channel, truncateForSlack(answer)); // fallback
  } catch (e) {
    const errText = e instanceof Error ? e.message : String(e);
    if (statusTs !== undefined) await updateMessage(token, msg.channel, statusTs, `⚠️ Error: ${errText}`);
    else await postMessage(token, msg.channel, `⚠️ Error: ${errText}`).catch(() => {});
  }
}

async function main(): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN;
  if (!token) { console.error("SLACK_BOT_TOKEN is required"); process.exit(1); }
  if (!appToken) { console.error("SLACK_APP_TOKEN is required"); process.exit(1); }

  const allowed = parseAllowedSlackIds(process.env.SLACK_ALLOWED_USER_IDS);
  if (allowed.size === 0) { console.error("Refusing to start without SLACK_ALLOWED_USER_IDS"); process.exit(1); }

  const runtime = await buildAgentFromEnv(); // singleton — reused for every message
  console.error(`tachi-agent Slack bot ready · ${runtime.toolCount} downstream tools`);

  const shutdown = async () => { try { await runtime.close(); } finally { process.exit(0); } };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Reconnect loop: Slack sends a "disconnect" frame before maintenance.
  // Exponential backoff on failure (1s → 30s); reset to 1s after a healthy socket.
  const BACKOFF_MIN_MS = 1000;
  const BACKOFF_MAX_MS = 30_000;
  const HEALTHY_MS = 60_000; // a socket open this long counts as healthy → reset backoff
  let backoffMs = BACKOFF_MIN_MS;
  while (true) {
    const connectedAt = Date.now();
    try {
      const url = await openSocketModeUrl(appToken);
      await new Promise<void>((resolve) => {
        const ws = new WebSocket(url);
        ws.addEventListener("message", (ev) => {
          let frame: any;
          try { frame = JSON.parse(typeof ev.data === "string" ? ev.data : ""); } catch { return; }
          if (frame.type === "disconnect") { ws.close(); return; }
          if (frame.type !== "events_api" || !frame.envelope_id) return;
          ack(ws, frame.envelope_id);
          const event = frame.payload?.event;
          const msg = extractSlackMessage(event);
          if (!msg) return;
          if (!isSlackAuthorized(msg.userId, allowed)) { console.error(`ignored unauthorized user ${msg.userId}`); return; }
          // each message independent — one error can't kill the socket; guard the rejection
          void handleEvent(runtime, token, msg).catch((e) => console.error("Slack handleEvent error:", e));
        });
        ws.addEventListener("close", () => resolve());
        ws.addEventListener("error", () => { try { ws.close(); } catch { /* noop */ } resolve(); });
      });
    } catch (e) {
      console.error("Slack socket error:", e);
    }
    // Reset backoff if the connection stayed open a healthy while; else escalate.
    if (Date.now() - connectedAt >= HEALTHY_MS) backoffMs = BACKOFF_MIN_MS;
    console.error(`Slack socket closed — reconnecting in ${backoffMs}ms…`);
    await new Promise<void>((r) => setTimeout(r, backoffMs));
    backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
