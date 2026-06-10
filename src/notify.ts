/**
 * Proactive outbound notifications — the "agent reaches out" half of bounded
 * autonomy: unattended (queued/scheduled) runs push their outcomes to humans
 * instead of waiting to be asked.
 *
 * Config: TACHI_NOTIFY — comma-separated `kind:target` entries, e.g.
 *   TACHI_NOTIFY="telegram:123456789,slack:C0123ABC"
 * Each kind uses its frontend's existing token env (TELEGRAM_BOT_TOKEN /
 * SLACK_BOT_TOKEN); targets without a token are skipped with a stderr warning.
 * Sends are best-effort: failures are the CALLER's problem to swallow.
 */
import { sendMessage } from "./frontends/telegram.js";
import { postMessage, truncateForSlack } from "./frontends/slack.js";

export interface NotifyTarget {
  kind: "telegram" | "slack";
  to: string;
}

export interface Notifier {
  send(text: string): Promise<void>;
}

/** Parse TACHI_NOTIFY. Malformed/unknown entries are dropped (fail-soft). */
export function parseNotifyTargets(env: string | undefined): NotifyTarget[] {
  if (!env) return [];
  const targets: NotifyTarget[] = [];
  for (const part of env.split(",")) {
    const [kind, to] = part.split(":").map((s) => s.trim());
    if ((kind === "telegram" || kind === "slack") && to) targets.push({ kind, to });
  }
  return targets;
}

/** Build a Notifier per configured target, skipping any whose token env is missing. */
export function createNotifiers(env: Record<string, string | undefined>): Notifier[] {
  const notifiers: Notifier[] = [];
  for (const target of parseNotifyTargets(env.TACHI_NOTIFY)) {
    if (target.kind === "telegram") {
      const token = env.TELEGRAM_BOT_TOKEN;
      if (!token) { console.error(`[notify] skipping telegram:${target.to} — TELEGRAM_BOT_TOKEN unset`); continue; }
      const chatId = Number(target.to);
      notifiers.push({ send: async (text) => { await sendMessage(token, chatId, text); } });
    } else {
      const token = env.SLACK_BOT_TOKEN;
      if (!token) { console.error(`[notify] skipping slack:${target.to} — SLACK_BOT_TOKEN unset`); continue; }
      notifiers.push({ send: async (text) => { await postMessage(token, target.to, truncateForSlack(text)); } });
    }
  }
  return notifiers;
}

/** Fan one message out to every notifier; per-target failures don't block the rest. */
export async function notifyAll(notifiers: Notifier[], text: string): Promise<void> {
  await Promise.allSettled(notifiers.map((n) => n.send(text)));
}
