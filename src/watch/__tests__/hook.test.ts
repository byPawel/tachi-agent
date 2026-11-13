import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { claim, clearQueue, enqueue, hookLive, inboxDir, installHooks, openInbox, readReceipt, runHook, withHooks } from "../hook.js";
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
    const stale = path.join(inboxDir(home), "old.q");
    const past = new Date(Date.now() - 8 * 24 * 60 * 60_000);
    fs.utimesSync(stale, past, past);
    openInbox(home);
    expect(fs.readdirSync(inboxDir(home))).toEqual(["new.q"]);
  });

  it("keeps a message until Claude Code has the text: a hook that dies after claiming loses nothing", () => {
    const id = enqueue("s1", "do not lose me", home);
    const first = claim({ session_id: "s1", hook_event_name: "PostToolUse" }, home);
    expect(first.out).toContain("do not lose me");
    // …and dies here, before commit(): no receipt, and the message is still on disk
    expect(readReceipt("s1", id, home)).toBeUndefined();
    // a hook firing right after must not deliver it a second time while the first may still be printing
    expect(runHook({ session_id: "s1", hook_event_name: "PostToolUse" }, home)).toBeUndefined();
    // a minute on, the claim is plainly abandoned: the next hook delivers it
    const later = runHook({ session_id: "s1", hook_event_name: "Stop" }, home, Date.now() + 61_000);
    expect(JSON.parse(later!).reason).toContain("do not lose me");
    expect(readReceipt("s1", id, home)).toEqual({ via: "Stop" });
    expect(fs.readdirSync(path.join(inboxDir(home), "s1.q"))).toEqual([]);
  });

  it("a message queued while a hook is draining is delivered by the next hook, never dropped", () => {
    enqueue("s1", "first", home);
    const draining = claim({ session_id: "s1", hook_event_name: "PostToolUse" }, home);
    const late = enqueue("s1", "second", home); // lands between the claim and the commit
    draining.commit();
    expect(draining.out).not.toContain("second");
    expect(JSON.parse(runHook({ session_id: "s1", hook_event_name: "PostToolUse" }, home)!).hookSpecificOutput.additionalContext).toContain("second");
    expect(readReceipt("s1", late, home)).toEqual({ via: "PostToolUse" });
  });

  it("never shows the hook a half-written message", () => {
    enqueue("s1", "whole", home);
    const q = path.join(inboxDir(home), "s1.q");
    fs.writeFileSync(path.join(q, ".abc.tmp"), '{"id":"x","text":"par'); // a writer mid-write
    const out = runHook({ session_id: "s1", hook_event_name: "PostToolUse" }, home)!;
    expect(out).toContain("whole");
    expect(out).not.toContain("par");
    expect(fs.readdirSync(q)).toEqual([".abc.tmp"]);
  });

  it("delivers messages in the order they were sent, even within one millisecond", () => {
    const now = Date.now();
    for (let i = 0; i < 12; i++) enqueue("s1", `m${String(i).padStart(2, "0")}`, home, now);
    const out = JSON.parse(runHook({ session_id: "s1", hook_event_name: "Stop" }, home)!).reason as string;
    expect(out.match(/m\d\d/g)).toEqual(Array.from({ length: 12 }, (_, i) => `m${String(i).padStart(2, "0")}`));
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
  const cmd = "/node /pkg/dist/watch/hook.js --tachi-watch-hook";

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
    // an install from 0.6.0 carries no mark: it is known by the package path
    const twice = withHooks(withHooks({}, "/old/node /old/lib/node_modules/tachi-agent/dist/watch/hook.js"), cmd);
    expect(twice.hooks!.Stop).toHaveLength(1);
    expect(twice.hooks!.Stop[0].hooks![0].command).toBe(cmd);
    expect(withHooks(twice, undefined)).toEqual({});
    expect(withHooks({ hooks: { Stop: [{ hooks: [{ type: "command", command: "other.sh" }, { type: "command", command: cmd }] }] } }, undefined))
      .toEqual({ hooks: { Stop: [{ hooks: [{ type: "command", command: "other.sh" }] }] } });
  });

  it("leaves someone else's hook alone, even one that is also called watch/hook.js", () => {
    const theirs = { hooks: { Stop: [{ hooks: [{ type: "command", command: "node /other-product/watch/hook.js" }] }] } };
    expect(withHooks(theirs, cmd).hooks!.Stop.map((e) => e.hooks![0].command)).toEqual(["node /other-product/watch/hook.js", cmd]);
    expect(withHooks(withHooks(theirs, cmd), undefined)).toEqual(theirs);
  });

  it("keeps the settings file's permissions and writes through a symlink instead of replacing it", () => {
    const real = path.join(home, "dotfiles", "settings.json");
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, JSON.stringify({ model: "x" }), { mode: 0o640 });
    fs.chmodSync(real, 0o640);
    const link = path.join(home, "settings.json");
    fs.symlinkSync(real, link);
    installHooks(link, cmd);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.statSync(real).mode & 0o777).toBe(0o640);
    expect(JSON.parse(fs.readFileSync(real, "utf8"))).toMatchObject({ model: "x", hooks: { Stop: expect.any(Array) } });
    expect(fs.readdirSync(path.dirname(real))).toEqual(["settings.json"]);
    // a settings file we create holds hook commands: readable by its owner only
    const fresh = path.join(home, "new", "settings.json");
    installHooks(fresh, cmd);
    expect(fs.statSync(fresh).mode & 0o777).toBe(0o600);
  });

  it("writes the project's settings.local.json, or the user's with --global; never a file it cannot parse", () => {
    const cwd = path.join(home, "proj");
    setupHooks({ ...parseWatchArgs(["--install-hooks", "--cwd", cwd], {}) }, home);
    const local = JSON.parse(fs.readFileSync(path.join(cwd, ".claude", "settings.local.json"), "utf8"));
    expect(local.hooks.UserPromptSubmit[0].hooks[0].command).toMatch(/watch[\\/]hook\.[jt]s'? --tachi-watch-hook$/);
    expect(fs.readdirSync(path.join(cwd, ".claude"))).toEqual(["settings.local.json"]); // no temp file left behind
    setupHooks(parseWatchArgs(["--uninstall-hooks", "--cwd", cwd], {}), home);
    expect(JSON.parse(fs.readFileSync(path.join(cwd, ".claude", "settings.local.json"), "utf8"))).toEqual({});

    expect(parseWatchArgs(["--install-hooks", "--global"], {})).toMatchObject({ hooks: "install", global: true });
    const broken = path.join(home, "broken.json");
    fs.writeFileSync(broken, "{ not json");
    expect(() => installHooks(broken, cmd)).toThrow();
    expect(fs.readFileSync(broken, "utf8")).toBe("{ not json");
  });
});
