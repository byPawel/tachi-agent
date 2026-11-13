/** A click on a link in the MEMORY document opens it in the browser (spawn is faked). */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";

const spawned: string[][] = [];
vi.mock("node:child_process", async (orig) => ({
  ...(await orig<typeof import("node:child_process")>()),
  spawn: (cmd: string, args: string[]) => {
    spawned.push([cmd, ...args]);
    return { unref() {} };
  },
}));

describe("links in MEMORY", () => {
  it("clicking a link opens it in Chrome", async () => {
    const { renderWatchUi } = await import("../ui.js");
    const dir = fs.mkdtempSync("/tmp/tw-link-");
    fs.writeFileSync(`${dir}/note.md`, "see [the docs](https://example.com/docs) here\n");
    const s = {
      cards: [], startedAt: Date.now(), untilReview: 3, session: "abcd1234", cwd: dir, brain: "codex", tachibot: "connected", memory: "1 files",
      reviewing: false, thinking: false, configFrom: [], layout: "stack", prompts: [], labels: {}, memoryList: ["note.md"], dokoroSearch: false, mouse: false,
    };
    const controller = {
      getState: () => s, subscribe: () => () => {}, handleLine: () => true,
      send() {}, cancelProposal() {}, loadTechniques: async () => {}, recommendTechniques: async () => {}, proposeTechnique() {},
    };
    const out = new EventEmitter() as EventEmitter & { columns: number; rows: number; isTTY: boolean; last: string; write: (t: string) => boolean };
    Object.assign(out, { columns: 120, rows: 30, isTTY: true, last: "", write(t: string) { this.last = t; return true; } });
    const stdin = new EventEmitter();
    const q: string[] = [];
    Object.assign(stdin, { isTTY: true, setRawMode() {}, setEncoding() {}, ref() {}, unref() {}, read: () => q.shift() ?? null, resume() {}, pause() {} });
    void renderWatchUi(controller as never, { stdout: out as never, stdin: stdin as never, debug: true, patchConsole: false, exitOnCtrlC: false });
    const press = async (k: string) => { q.push(k); stdin.emit("readable"); await new Promise((r) => setTimeout(r, 40)); };
    await new Promise((r) => setTimeout(r, 60));
    await press("\x1b[Z"); // Shift+Tab → MEMORY
    const plain = out.last.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x07]*\x07/g, "").split("\n");
    // find "the docs" on screen and click its middle
    const y = plain.findIndex((l) => l.includes("the docs"));
    const x = plain[y].indexOf("the docs") + 3;
    expect(y).toBeGreaterThan(0);
    await press(`\x1b[<0;${x + 1};${y + 1}M`);
    expect(spawned.at(-1)).toEqual(["open", "-a", "Google Chrome", "https://example.com/docs"]);
    await new Promise((r) => setTimeout(r, 60));
    expect(out.last).toContain("opened in Chrome");
  });
});
