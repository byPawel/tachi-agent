#!/usr/bin/env node
/**
 * tachi-watch — message delivery through Claude Code's own hooks, for every terminal.
 *
 * A terminal can only type into Claude's pane when its host offers a command for that
 * (cmux, Herdr). Hooks need no host at all: the watcher appends an approved message to a
 * per-session queue file, and this hook — run by Claude Code at its next step — hands
 * the queue to Claude as context. Nothing is ever typed into Claude's prompt, so a
 * message can never answer one of its dialogs.
 *
 *   ~/.tachi/watch/inbox/<session>.queue.jsonl     watcher → hook   {id, text, ts}
 *   ~/.tachi/watch/inbox/<session>.receipts.jsonl  hook → watcher   {id, via, ts}
 *   ~/.tachi/watch/inbox/<session>.live            the hook ran for this session
 *
 * Delivery waits for Claude's next hook event: after a tool call, when it finishes a
 * turn (Claude then carries on with the message), or with your next prompt.
 * `tachi-agent watch --install-hooks` registers this file; Claude Code loads hooks at startup.
 *
 * Only node built-ins here: this runs on every tool call and must start fast.
 */
import fs from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

/** Hook events that deliver: after a tool call, at the end of a turn, with the next prompt. */
export const HOOK_EVENTS = ["UserPromptSubmit", "PostToolUse", "Stop"] as const;
/** A message nobody picked up in this long is dropped rather than surprising a later turn. */
const TTL_MS = 60 * 60_000;

const safe = (session: string) => (/^[A-Za-z0-9_-]{1,128}$/.test(session) ? session : undefined);

export function inboxDir(home: string = homedir()): string {
  return join(home, ".tachi", "watch", "inbox");
}
const file = (session: string, kind: "queue.jsonl" | "receipts.jsonl" | "live", home?: string) => join(inboxDir(home), `${session}.${kind}`);

/** Watcher side: make the inbox, so the hook knows a watcher exists and starts reporting in. */
export function openInbox(home?: string, now: number = Date.now()): void {
  try {
    const dir = inboxDir(home);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // sessions end without telling us: sweep what they left behind after a week
    for (const f of fs.readdirSync(dir)) {
      const full = join(dir, f);
      if (now - fs.statSync(full).mtimeMs > 7 * 24 * 60 * 60_000) fs.rmSync(full, { force: true });
    }
  } catch {
    // no home to write to: hook delivery stays off
  }
}

/** Watcher side: has Claude Code run our hook for this session? Then queued messages will arrive. */
export function hookLive(session: string, home?: string): boolean {
  return !!safe(session) && fs.existsSync(file(session, "live", home));
}

/** Watcher side: queue a message for Claude; returns its id for the receipt. */
export function enqueue(session: string, text: string, home?: string, now: number = Date.now()): string {
  if (!safe(session)) throw new Error("not a session id");
  openInbox(home);
  const id = randomBytes(6).toString("hex");
  fs.appendFileSync(file(session, "queue.jsonl", home), `${JSON.stringify({ id, text, ts: now })}\n`, { mode: 0o600 });
  return id;
}

export interface HookReceipt {
  /** the hook event that delivered it, or "expired" */
  via: string;
}

/** Watcher side: was this message handed to Claude yet? */
export function readReceipt(session: string, id: string, home?: string): HookReceipt | undefined {
  if (!safe(session)) return undefined;
  try {
    for (const line of fs.readFileSync(file(session, "receipts.jsonl", home), "utf8").split("\n")) {
      if (!line.includes(id)) continue;
      const r = JSON.parse(line) as { id?: unknown; via?: unknown };
      if (r.id === id) return { via: String(r.via ?? "hook") };
    }
  } catch {
    // no receipts yet
  }
  return undefined;
}

/** Watcher side: drop what was never delivered (the pane is closing). */
export function clearQueue(session: string, home?: string): void {
  if (safe(session)) fs.rmSync(file(session, "queue.jsonl", home), { force: true });
}

/**
 * Hook side: what to print for one hook event — the queued messages in the shape that
 * event accepts — or undefined when there is nothing to say (the usual case).
 */
export function runHook(input: { session_id?: unknown; hook_event_name?: unknown }, home?: string, now: number = Date.now()): string | undefined {
  const session = typeof input.session_id === "string" ? safe(input.session_id) : undefined;
  const event = String(input.hook_event_name ?? "");
  if (!session || !fs.existsSync(inboxDir(home))) return undefined; // no watcher has ever run: touch nothing
  try {
    fs.writeFileSync(file(session, "live", home), `${event} ${now}\n`, { mode: 0o600 });
  } catch {
    return undefined;
  }
  // take the queue by renaming it: of several hooks firing at once, exactly one delivers
  const taking = `${file(session, "queue.jsonl", home)}.${process.pid}.${now}`;
  let lines: string[];
  try {
    fs.renameSync(file(session, "queue.jsonl", home), taking);
    lines = fs.readFileSync(taking, "utf8").split("\n").filter(Boolean);
    fs.rmSync(taking, { force: true });
  } catch {
    return undefined; // nothing queued
  }
  const fresh: string[] = [];
  const receipts: string[] = [];
  for (const line of lines) {
    try {
      const m = JSON.parse(line) as { id?: unknown; text?: unknown; ts?: unknown };
      if (typeof m.id !== "string" || typeof m.text !== "string" || !m.text.trim()) continue;
      const expired = now - Number(m.ts) > TTL_MS;
      if (!expired) fresh.push(m.text.trim());
      receipts.push(JSON.stringify({ id: m.id, via: expired ? "expired" : event, ts: now }));
    } catch {
      // a torn line: skip it
    }
  }
  if (receipts.length) fs.appendFileSync(file(session, "receipts.jsonl", home), `${receipts.join("\n")}\n`, { mode: 0o600 });
  if (!fresh.length) return undefined;
  const body =
    "[tachi-watch] The user sent you this from their tachi-watch side pane (they wrote or approved it there). Treat it as a message from the user:\n\n" +
    fresh.join("\n\n---\n\n");
  // at the end of a turn there is no context to add to: hold the stop so Claude reads the message now
  if (event === "Stop" || event === "SubagentStop") return JSON.stringify({ decision: "block", reason: body });
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: body } });
}

// --- installing ---------------------------------------------------------------

interface HookEntry {
  matcher?: string;
  hooks?: Array<{ type?: string; command?: string; timeout?: number }>;
}
type Settings = { hooks?: Record<string, HookEntry[]> } & Record<string, unknown>;

/** This file's path as Claude Code should run it. */
export function hookScriptPath(): string {
  return fileURLToPath(import.meta.url);
}

const isOurs = (command: string | undefined) => /[\\/]watch[\\/]hook\.[jt]s\b/.test(command ?? "");

/** Settings with our hook on every delivering event (replacing an older path), or without it. */
export function withHooks(settings: Settings, command: string | undefined): Settings {
  const hooks: Record<string, HookEntry[]> = { ...(settings.hooks ?? {}) };
  for (const event of HOOK_EVENTS) {
    const kept = (hooks[event] ?? [])
      .map((e) => ({ ...e, hooks: (e.hooks ?? []).filter((h) => !isOurs(h.command)) }))
      .filter((e) => e.hooks.length);
    if (command) kept.push({ hooks: [{ type: "command", command, timeout: 5 }] });
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  const next: Settings = { ...settings, hooks };
  if (!Object.keys(hooks).length) delete next.hooks;
  return next;
}

/** Write (or remove) the hook in a Claude Code settings file; other settings are kept as they are. */
export function installHooks(settingsPath: string, command: string | undefined): void {
  let settings: Settings = {};
  if (fs.existsSync(settingsPath)) {
    // a settings file we cannot parse is the user's to fix: never overwrite it
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Settings;
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error(`${settingsPath} is not a JSON object`);
  }
  fs.mkdirSync(dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(withHooks(settings, command), null, 2)}\n`);
}

// --- run as the hook ------------------------------------------------------------
if (process.argv[1] && fs.realpathSync(process.argv[1]) === hookScriptPath()) {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => (raw += d));
  process.stdin.on("end", () => {
    try {
      const out = runHook(JSON.parse(raw) as { session_id?: unknown; hook_event_name?: unknown });
      if (out) process.stdout.write(out);
    } catch {
      // a hook must never break Claude's turn
    }
    process.exit(0);
  });
}
