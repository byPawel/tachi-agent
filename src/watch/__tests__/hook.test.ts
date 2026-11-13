import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { clearQueue, enqueue, hookLive, inboxDir, installHooks, openInbox, readReceipt, runHook, withHooks } from "../hook.js";
import { parseWatchArgs, setupHooks } from "../watch.js";

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "tw-hook-"));
});

describe("delivery through Claude Code's hooks", () => {
  it("does nothing, and writes nothing, until a watcher has opened the inbox", () => {
    expect(runHook({ session_id: "s1", hook_event_name: "PostToolUse" }, home)).toBeUndefined();
    expect(fs.existsSync(inboxDir(home))).toBe(false);
    expect(hookLive("s1", home)).toBe(false);
  });

  it("reports in for the session, then hands a queued message to Claude as context — once", () => {
    openInbox(home);
    expect(runHook({ session_id: "s1", hook_event_name: "UserPromptSubmit" }, home)).toBeUndefined();
    expect(hookLive("s1", home)).toBe(true);
    expect(hookLive("other", home)).toBe(false);

    const id = enqueue("s1", "check the 429 handling", home);
    expect(readReceipt("s1", id, home)).toBeUndefined();
    const out = JSON.parse(runHook({ session_id: "s1", hook_event_name: "PostToolUse" }, home)!);
    expect(out.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(out.hookSpecificOutput.additionalContext).toMatch(/^\[tachi-watch\] .*message from the user:\n\ncheck the 429 handling$/s);
    expect(readReceipt("s1", id, home)).toEqual({ via: "PostToolUse" });
    expect(runHook({ session_id: "s1", hook_event_name: "PostToolUse" }, home)).toBeUndefined();
  });

  it("holds the end of a turn so Claude reads the message now, and joins several", () => {
    const a = enqueue("s1", "first", home);
    const b = enqueue("s1", "second", home);
    const out = JSON.parse(runHook({ session_id: "s1", hook_event_name: "Stop" }, home)!);
    expect(out.decision).toBe("block");
    expect(out.reason).toContain("first\n\n---\n\nsecond");
    expect(readReceipt("s1", a, home)?.via).toBe("Stop");
    expect(readReceipt("s1", b, home)?.via).toBe("Stop");
  });

  it("keeps sessions apart, drops stale messages, and clears the queue when the pane closes", () => {
    const mine = enqueue("s1", "for s1", home);
    expect(runHook({ session_id: "s2", hook_event_name: "PostToolUse" }, home)).toBeUndefined();
    expect(readReceipt("s1", mine, home)).toBeUndefined();

    const old = enqueue("s3", "an hour ago", home, Date.now() - 2 * 60 * 60_000);
    expect(runHook({ session_id: "s3", hook_event_name: "PostToolUse" }, home)).toBeUndefined();
    expect(readReceipt("s3", old, home)).toEqual({ via: "expired" });

    clearQueue("s1", home);
    expect(runHook({ session_id: "s1", hook_event_name: "PostToolUse" }, home)).toBeUndefined();
  });

  it("sweeps files that ended sessions left behind a week ago", () => {
    enqueue("old", "x", home);
    enqueue("new", "y", home);
    const stale = path.join(inboxDir(home), "old.queue.jsonl");
    const past = new Date(Date.now() - 8 * 24 * 60 * 60_000);
    fs.utimesSync(stale, past, past);
    openInbox(home);
    expect(fs.readdirSync(inboxDir(home))).toEqual(["new.queue.jsonl"]);
  });

  it("refuses a session id that could leave the inbox folder", () => {
    openInbox(home);
    expect(() => enqueue("../../etc/x", "t", home)).toThrow();
    expect(runHook({ session_id: "../x", hook_event_name: "Stop" }, home)).toBeUndefined();
    expect(fs.readdirSync(inboxDir(home))).toEqual([]);
  });

  it("runs as a script: hook JSON on stdin, the message on stdout", () => {
    const id = enqueue("s9", "from the pane", home);
    const script = path.resolve("dist/watch/hook.js");
    if (!fs.existsSync(script)) return; // needs `npm run build`
    const out = execFileSync(process.execPath, [script], { input: JSON.stringify({ session_id: "s9", hook_event_name: "UserPromptSubmit" }), env: { ...process.env, HOME: home }, encoding: "utf8" });
    expect(JSON.parse(out).hookSpecificOutput.additionalContext).toContain("from the pane");
    expect(readReceipt("s9", id, home)?.via).toBe("UserPromptSubmit");
  });
});

describe("installing the hook", () => {
  const cmd = "/node /pkg/dist/watch/hook.js";

  it("adds one entry per delivering event and keeps everything else", () => {
    const before = { model: "x", hooks: { Stop: [{ hooks: [{ type: "command", command: "other.sh" }] }], SessionStart: [{ hooks: [{ type: "command", command: "s.sh" }] }] } };
    const after = withHooks(before, cmd);
    expect(after.model).toBe("x");
    expect(after.hooks!.SessionStart).toEqual(before.hooks.SessionStart);
    expect(after.hooks!.Stop.map((e) => e.hooks![0].command)).toEqual(["other.sh", cmd]);
    expect(after.hooks!.PostToolUse).toEqual([{ hooks: [{ type: "command", command: cmd, timeout: 5 }] }]);
    expect(Object.keys(after.hooks!).sort()).toEqual(["PostToolUse", "SessionStart", "Stop", "UserPromptSubmit"]);
  });

  it("replaces an older install instead of stacking, and uninstalls cleanly", () => {
    const twice = withHooks(withHooks({}, "/old/node /old/dist/watch/hook.js"), cmd);
    expect(twice.hooks!.Stop).toHaveLength(1);
    expect(twice.hooks!.Stop[0].hooks![0].command).toBe(cmd);
    expect(withHooks(twice, undefined)).toEqual({});
    expect(withHooks({ hooks: { Stop: [{ hooks: [{ type: "command", command: "other.sh" }, { type: "command", command: cmd }] }] } }, undefined))
      .toEqual({ hooks: { Stop: [{ hooks: [{ type: "command", command: "other.sh" }] }] } });
  });

  it("writes the project's settings.local.json, or the user's with --global; never a file it cannot parse", () => {
    const cwd = path.join(home, "proj");
    setupHooks({ ...parseWatchArgs(["--install-hooks", "--cwd", cwd], {}) }, home);
    const local = JSON.parse(fs.readFileSync(path.join(cwd, ".claude", "settings.local.json"), "utf8"));
    expect(local.hooks.UserPromptSubmit[0].hooks[0].command).toMatch(/watch[\\/]hook\.[jt]s'?$/);
    setupHooks(parseWatchArgs(["--uninstall-hooks", "--cwd", cwd], {}), home);
    expect(JSON.parse(fs.readFileSync(path.join(cwd, ".claude", "settings.local.json"), "utf8"))).toEqual({});

    expect(parseWatchArgs(["--install-hooks", "--global"], {})).toMatchObject({ hooks: "install", global: true });
    const broken = path.join(home, "broken.json");
    fs.writeFileSync(broken, "{ not json");
    expect(() => installHooks(broken, cmd)).toThrow();
    expect(fs.readFileSync(broken, "utf8")).toBe("{ not json");
  });
});
