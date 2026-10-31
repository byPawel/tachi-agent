/**
 * Key routing and state isolation — the real pane rendered headless, driven by key
 * bytes. Each case asserts what the footer (the active tab) and the screen show.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { renderWatchUi } from "../ui.js";

const TAB = "\t";
const SHIFT_TAB = "\x1b[Z";
const ESC = "\x1b";
const CTRL_F = "\x06";

function state() {
  const now = Date.now();
  return {
    cards: [
      { key: "c1", type: "tool", via: "tachibot", tool: "grok_search", title: "tachibot · grok_search", source: "claude", depth: 0, status: "ok", ts: now - 60_000, ms: 1000, input: "alpha query", full: "alpha answer" },
      { key: "c2", type: "tool", via: "tachibot", tool: "kimi_thinking", title: "tachibot · kimi_thinking", source: "claude", depth: 0, status: "ok", ts: now - 30_000, ms: 2000, input: "beta problem", full: "beta answer" },
      { key: "a1", type: "answer", source: "watch", depth: 0, ts: now - 20_000, status: "info", title: "watch", input: "why beta?", output: "because beta" },
    ],
    startedAt: now, untilReview: 3, session: "18d7a7df-test", cwd: "/tmp", brain: "codex", tachibot: "connected", memory: "1 files",
    reviewing: false, thinking: false, configFrom: [], layout: "stack", prompts: [], labels: {}, memoryList: [], dokoroSearch: false, mouse: false,
  };
}

/** Render, press keys one by one, return the last frame as plain text. */
async function run(keys: string[], cols = 100, rows = 34): Promise<string> {
  return runWith(state(), keys, cols, rows);
}
async function runWith(s: ReturnType<typeof state>, keys: string[], cols = 100, rows = 34): Promise<string> {
  const lines: string[] = [];
  const controller = {
    getState: () => s, subscribe: () => () => {},
    handleLine: (l: string) => { lines.push(l); return true; },
    send() {}, cancelProposal() {}, loadTechniques: async () => {}, recommendTechniques: async () => {}, proposeTechnique() {},
  };
  const out = new EventEmitter() as EventEmitter & { columns: number; rows: number; isTTY: boolean; last: string; write: (s: string) => boolean };
  Object.assign(out, { columns: cols, rows, isTTY: true, last: "", write(t: string) { this.last = t; return true; } });
  const stdin = new EventEmitter();
  const q: string[] = [];
  Object.assign(stdin, { isTTY: true, setRawMode() {}, setEncoding() {}, ref() {}, unref() {}, read: () => q.shift() ?? null, resume() {}, pause() {} });
  void renderWatchUi(controller as never, { stdout: out as never, stdin: stdin as never, debug: true, patchConsole: false, exitOnCtrlC: false });
  await new Promise((r) => setTimeout(r, 60));
  for (const k of keys) {
    q.push(k);
    stdin.emit("readable");
    await new Promise((r) => setTimeout(r, 25));
  }
  await new Promise((r) => setTimeout(r, 80));
  (run as unknown as { lines: string[] }).lines = lines;
  return out.last.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x07]*\x07/g, "");
}
const footer = (frame: string) => frame.trimEnd().split("\n").pop()!.trim().split(" ")[0];

describe("key routing", () => {
  it("Tab rings forward and Shift+Tab back", async () => {
    expect(footer(await run([TAB]))).toBe("calls");
    expect(footer(await run([TAB, TAB, TAB, TAB]))).toBe("memory");
    expect(footer(await run([TAB, TAB, TAB, TAB, TAB]))).toBe("home");
    expect(footer(await run([SHIFT_TAB]))).toBe("memory");
    expect(footer(await run([TAB, TAB, SHIFT_TAB]))).toBe("calls");
  });

  it("Esc backs out exactly one layer", async () => {
    // search with a query → Esc clears the search, stays in CALLS
    expect(footer(await run([TAB, CTRL_F, "a", "l", "p", "h", "a", ESC]))).toBe("calls");
    // a second Esc goes HOME
    expect(footer(await run([TAB, CTRL_F, "a", ESC, ESC]))).toBe("home");
    // typed text: Esc clears it first, the tab stays
    const typed = await run([TAB, TAB, "h", "i", ESC]);
    expect(footer(typed)).toBe("chat");
  });

  it("a search in CALLS never filters CHAT", async () => {
    const frame = await run([TAB, CTRL_F, "a", "l", "p", "h", "a", "\r", TAB]);
    expect(footer(frame)).toBe("chat");
    expect(frame).toContain("because beta"); // the chat is unfiltered
    expect(frame).not.toContain("filter ›");
  });

  it("the CALLS search filters the calls", async () => {
    const frame = await run([TAB, CTRL_F, "b", "e", "t", "a", "\r"]);
    expect(frame).toContain("kimi_thinking");
    expect(frame).toContain("1 of 2 calls");
  });

  it("the help overlay owns the keys while open", async () => {
    const frame = await run(["?", TAB]);
    expect(frame).toContain("KEYS · HOME");
    expect(footer(frame)).toBe("home"); // Tab did not switch tabs under the overlay
    expect(await run(["?", ESC])).not.toContain("KEYS ·");
  });

  it("letters typed into the ask input never trigger shortcuts", async () => {
    const frame = await run([TAB, TAB, "g", "?", "G"]);
    expect(footer(frame)).toBe("chat");
    expect(frame).not.toContain("KEYS ·");
    expect(frame).toContain("g?G");
  });
});

describe("mouse in MEMORY", () => {
  it("the wheel over the document scrolls it, even in the wide layout", async () => {
    const s = state();
    // a real file to read
    (s as { memoryList: string[] }).memoryList = ["long.md"];
    const fs = await import("node:fs");
    const dir = fs.mkdtempSync("/tmp/tw-");
    fs.writeFileSync(`${dir}/long.md`, Array.from({ length: 120 }, (_, i) => `line ${i + 1}`).join("\n\n"));
    (s as { cwd: string }).cwd = dir;
    (s as { layout: string }).layout = "split";
    const frame = await runWith(s, [SHIFT_TAB, "\x1b[<65;120;15M", "\x1b[<65;120;15M"], 160);
    expect(frame).toMatch(/7–[0-9]+ \/ [0-9]+ · [0-9]+%/);
    expect(footer(frame)).toBe("memory");
  });
});

describe("MEMORY reader keys", () => {
  it("^O jumps to the next heading and ^R shows the raw markdown", async () => {
    const fs = await import("node:fs");
    const dir = fs.mkdtempSync("/tmp/tw-o-");
    fs.writeFileSync(`${dir}/doc.md`, ["# Top", "", ...Array.from({ length: 40 }, (_, i) => `para ${i}`), "## Second part", "", ...Array.from({ length: 40 }, (_, i) => `more ${i}`)].join("\n"));
    const s = state();
    Object.assign(s, { cwd: dir, memoryList: ["doc.md"] });
    const jumped = await runWith(s, [SHIFT_TAB, "\x0f"], 120, 30);
    expect(jumped).toMatch(/▍ Second part/);
    const raw = await runWith(state() && Object.assign(state(), { cwd: dir, memoryList: ["doc.md"] }), [SHIFT_TAB, "\x12"], 120, 30);
    expect(raw).toContain("# Top");
    expect(raw).toContain("RAW");
  });
});

describe("accordion", () => {
  it("clicking a card's ▾ INPUT header folds it, clicking again opens it", async () => {
    const plain = (f: string) => f.split("\n");
    const { foldedSections } = await import("../ui.js");
    foldedSections.clear();
    const s = state();
    const frame1 = await runWith(s, [TAB], 100, 34);
    const y = plain(frame1).findIndex((l) => l.includes("▾ INPUT"));
    expect(y).toBeGreaterThan(0);
    const x = plain(frame1)[y].indexOf("▾ INPUT") + 3;
    const folded = await runWith(state(), [TAB, `\x1b[<0;${x};${y + 1}M`, "\x1b[<0;1;1m"], 100, 34);
    expect(folded).toContain("▸ INPUT");
    expect(folded).toMatch(/line[s]? folded/);
    const opened = await runWith(state(), [TAB, `\x1b[<0;${x};${y + 1}M`, "\x1b[<0;1;1m"], 100, 34);
    expect(opened).toContain("▾ INPUT");
  });
});
