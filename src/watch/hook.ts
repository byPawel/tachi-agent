#!/usr/bin/env node
/**
 * tachi-watch — message delivery through Claude Code's own hooks, for every terminal.
 *
 * A terminal can only type into Claude's pane when its host offers a command for that
 * (cmux, Herdr). Hooks need no host at all: the watcher writes an approved message into
 * a per-session inbox, and this hook — run by Claude Code at its next step — hands the
 * inbox to Claude as context. Nothing is ever typed into Claude's prompt, so a message
 * can never answer one of its dialogs.
 *
 *   ~/.tachi/watch/inbox/<session>.q/<ts>-<id>.msg   watcher → hook, one file per message
 *   ~/.tachi/watch/inbox/<session>.receipts.jsonl    hook → watcher   {id, via, ts}
 *   ~/.tachi/watch/inbox/<session>.live              the hook ran for this session
 *
 * One file per message, each written whole and then renamed into place, so a writer and a
 * reader can never tear or lose one. The hook claims a message by renaming it, prints it
 * for Claude, and only then deletes it and writes the receipt: a hook that dies in between
 * leaves the claim behind, and a hook a minute later delivers it again. That is the chosen
 * trade: in that rare case Claude may see a message twice, but it never misses one.
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
/** A claim this old belongs to a hook that died before it could print: the message is taken again. */
const CLAIM_MS = 60_000;
/** Marks our entry in a Claude Code settings file; the script ignores it. */
export const HOOK_MARK = "--tachi-watch-hook";

let sent = 0;

const safe = (session: string) => (/^[A-Za-z0-9_-]{1,128}$/.test(session) ? session : undefined);

export function inboxDir(home: string = homedir()): string {
  return join(home, ".tachi", "watch", "inbox");
}
const file = (session: string, kind: "q" | "receipts.jsonl" | "live", home?: string) => join(inboxDir(home), `${session}.${kind}`);

/** Watcher side: make the inbox, so the hook knows a watcher exists and starts reporting in. */
export function openInbox(home?: string, now: number = Date.now()): void {
  try {
    const dir = inboxDir(home);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // sessions end without telling us: sweep what they left behind after a week
    for (const f of fs.readdirSync(dir)) {
      const full = join(dir, f);
      if (now - fs.statSync(full).mtimeMs > 7 * 24 * 60 * 60_000) fs.rmSync(full, { recursive: true, force: true });
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
  const dir = file(session, "q", home);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const id = randomBytes(6).toString("hex");
  // whole file first, then the rename: the hook only ever sees a complete message
  const tmp = join(dir, `.${id}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ id, text, ts: now }), { mode: 0o600 });
  // the counter keeps two messages approved in the same millisecond in the order they were sent
  fs.renameSync(tmp, join(dir, `${String(now).padStart(15, "0")}-${String(++sent).padStart(6, "0")}-${id}.msg`));
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
  if (safe(session)) fs.rmSync(file(session, "q", home), { recursive: true, force: true });
}

export interface Claim {
  /** what to print for Claude Code; undefined when there is nothing to say */
  out?: string;
  /** call once `out` has been written: deletes the claimed messages and writes their receipts */
  commit(): void;
}

/**
 * Hook side, step one: report in, claim this session's queued messages and say what to
 * print for this hook event. Nothing is deleted until `commit()`.
 */
export function claim(input: { session_id?: unknown; hook_event_name?: unknown }, home?: string, now: number = Date.now()): Claim {
  const nothing: Claim = { commit: () => undefined };
  const session = typeof input.session_id === "string" ? safe(input.session_id) : undefined;
  const event = String(input.hook_event_name ?? "");
  if (!session || !fs.existsSync(inboxDir(home))) return nothing; // no watcher has ever run: touch nothing
  try {
    fs.writeFileSync(file(session, "live", home), `${event} ${now}\n`, { mode: 0o600 });
  } catch {
    return nothing;
  }
  const dir = file(session, "q", home);
  let names: string[];
  try {
    names = fs.readdirSync(dir).sort();
  } catch {
    return nothing; // nothing was ever queued
  }
  const mine = `.taken-${process.pid}-${now}`;
  const taken: string[] = [];
  const fresh: string[] = [];
  const receipts: string[] = [];
  for (const name of names) {
    // a claim left by a hook that died before printing: back in the queue for this one
    const stale = /^(.+\.msg)\.taken-\d+-(\d+)$/.exec(name);
    if (!name.endsWith(".msg") && !(stale && now - Number(stale[2]) > CLAIM_MS)) continue;
    const claimed = join(dir, `${stale ? stale[1] : name}${mine}`);
    try {
      fs.renameSync(join(dir, name), claimed); // of several hooks firing at once, exactly one gets it
    } catch {
      continue;
    }
    taken.push(claimed);
    try {
      const m = JSON.parse(fs.readFileSync(claimed, "utf8")) as { id?: unknown; text?: unknown; ts?: unknown };
      if (typeof m.id !== "string" || typeof m.text !== "string" || !m.text.trim()) continue;
      const expired = now - Number(m.ts) > TTL_MS;
      if (!expired) fresh.push(m.text.trim());
      receipts.push(JSON.stringify({ id: m.id, via: expired ? "expired" : event, ts: now }));
    } catch {
      // not a message we wrote: dropped at commit
    }
  }
  const commit = () => {
    try {
      if (receipts.length) fs.appendFileSync(file(session, "receipts.jsonl", home), `${receipts.join("\n")}\n`, { mode: 0o600 });
    } catch {
      // the message was delivered; the pane just keeps waiting for a receipt it will not get
    }
    for (const f of taken) fs.rmSync(f, { force: true });
  };
  if (!fresh.length) return { commit };
  const body =
    "[tachi-watch] The user sent you this from their tachi-watch side pane (they wrote or approved it there). Treat it as a message from the user:\n\n" +
    fresh.join("\n\n---\n\n");
  // at the end of a turn there is no context to add to: hold the stop so Claude reads the message now
  const out = event === "Stop" || event === "SubagentStop"
    ? JSON.stringify({ decision: "block", reason: body })
    : JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: body } });
  return { out, commit };
}

/** Both steps at once, for callers that hand the text on themselves. */
export function runHook(input: { session_id?: unknown; hook_event_name?: unknown }, home?: string, now: number = Date.now()): string | undefined {
  const c = claim(input, home, now);
  c.commit();
  return c.out;
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

/** The command Claude Code runs: `<node> <this file> --tachi-watch-hook`, each part quoted by `quote`. */
export function hookCommand(node: string, quote: (s: string) => string): string {
  return `${[node, hookScriptPath()].map(quote).join(" ")} ${HOOK_MARK}`;
}

// Ours carries the mark. An install from 0.6.0 has none: that one is known by the package's own path.
// Anything else — someone else's `…/watch/hook.js` — is not ours to touch.
const isOurs = (command: string | undefined) =>
  !!command && (command.includes(HOOK_MARK) || /tachi-agent[\\/](dist|src)[\\/]watch[\\/]hook\.[jt]s\b/.test(command));

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
  let target = settingsPath;
  let mode = 0o600; // a new settings file is the user's alone
  if (fs.existsSync(settingsPath)) {
    // a settings file kept in a dotfiles repo is a symlink: write through it, never replace the link
    target = fs.realpathSync(settingsPath);
    mode = fs.statSync(target).mode & 0o777; // and keep the permissions it had
    // a settings file we cannot parse is the user's to fix: never overwrite it
    settings = JSON.parse(fs.readFileSync(target, "utf8")) as Settings;
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error(`${settingsPath} is not a JSON object`);
  }
  fs.mkdirSync(dirname(target), { recursive: true });
  // whole file beside it, then the rename: an interrupted write never leaves half a settings file
  const tmp = `${target}.tachi-watch.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(withHooks(settings, command), null, 2)}\n`, { mode });
    fs.chmodSync(tmp, mode); // the mode above is masked by umask
    fs.renameSync(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

// --- run as the hook ------------------------------------------------------------
const runAsScript = (() => {
  try {
    return !!process.argv[1] && fs.realpathSync(process.argv[1]) === hookScriptPath();
  } catch {
    return false;
  }
})();
if (runAsScript) {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => (raw += d));
  process.stdin.on("end", () => {
    try {
      const c = claim(JSON.parse(raw) as { session_id?: unknown; hook_event_name?: unknown });
      if (!c.out) {
        c.commit();
        process.exit(0);
      }
      // the messages are only given up once Claude Code has the text
      process.stdout.write(c.out, (err) => {
        if (!err) c.commit();
        process.exit(0);
      });
    } catch {
      process.exit(0); // a hook must never break Claude's turn
    }
  });
}
