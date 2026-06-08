/**
 * context-inspect.test.ts
 *
 * Tests for the minimal context-inspector event emitter. The emitter writes a
 * single JSONL line describing the context layers assembled for a model call,
 * but ONLY when explicitly enabled (env TACHI_CONTEXT_INSPECT or opts.enabled).
 * The default (disabled) path must be a complete no-op — no file writes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildContextInspectEvent,
  emitContextInspect,
  estimateTokens,
  snippet,
  type ContextInspectEvent,
  type ContextInspectLayer,
} from "../context-inspect.js";
import type { ChatMessage, AgentTool } from "../types.js";

const TOOLS: AgentTool[] = [
  {
    name: "tachibot_jury",
    description: "multi-model jury",
    parameters: { type: "object", properties: { question: { type: "string" } } },
  },
];

const MESSAGES: ChatMessage[] = [
  { role: "system", content: "base system prompt text" },
  { role: "user", content: "what should we ship?" },
];

describe("estimateTokens", () => {
  it("estimates Math.ceil(length / 4)", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a")).toBe(1); // ceil(1/4)
    expect(estimateTokens("abcd")).toBe(1); // ceil(4/4)
    expect(estimateTokens("abcde")).toBe(2); // ceil(5/4)
    expect(estimateTokens("x".repeat(400))).toBe(100);
  });
});

describe("snippet", () => {
  it("returns the whole string when <= 500 chars", () => {
    const s = "hello world";
    expect(snippet(s)).toBe(s);
  });

  it("truncates to 500 chars", () => {
    const long = "z".repeat(1000);
    expect(snippet(long)).toHaveLength(500);
    expect(snippet(long)).toBe("z".repeat(500));
  });
});

describe("buildContextInspectEvent", () => {
  it("produces a correctly-shaped event", () => {
    const ev = buildContextInspectEvent({
      messages: MESSAGES,
      tools: TOOLS,
      turn: 1,
      sessionId: "sess-abc",
    });

    expect(ev.event).toBe("context_inspect");
    expect(ev.turn).toBe(1);
    expect(ev.sessionId).toBe("sess-abc");
    // ISO-8601 timestamp
    expect(ev.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(Array.isArray(ev.layers)).toBe(true);
    expect(ev.layers.length).toBeGreaterThan(0);
    // totalEstimate is the sum of per-layer token estimates
    const sum = ev.layers.reduce((acc, l) => acc + l.tokenEstimate, 0);
    expect(ev.totalEstimate).toBe(sum);
  });

  it("maps the system message to a 'system' layer and the user message to 'other'", () => {
    const ev = buildContextInspectEvent({ messages: MESSAGES, tools: [], turn: 0 });
    const names = ev.layers.map((l) => l.name);
    expect(names).toContain("system");
    expect(names).toContain("other");
    const system = ev.layers.find((l) => l.name === "system")!;
    expect(system.tokenEstimate).toBe(estimateTokens("base system prompt text"));
    expect(system.contentSnippet).toBe("base system prompt text");
    expect(typeof system.reason).toBe("string");
    expect(system.reason.length).toBeGreaterThan(0);
  });

  it("summarizes the tools array as a single 'tool' layer", () => {
    const ev = buildContextInspectEvent({ messages: MESSAGES, tools: TOOLS, turn: 0 });
    const tool = ev.layers.find((l) => l.name === "tool");
    expect(tool).toBeDefined();
    // token estimate based on the JSON length of the tool specs
    expect(tool!.tokenEstimate).toBe(estimateTokens(JSON.stringify(TOOLS)));
    expect(tool!.reason).toContain("1");
  });

  it("omits the tool layer when there are no tools", () => {
    const ev = buildContextInspectEvent({ messages: MESSAGES, tools: [], turn: 0 });
    expect(ev.layers.find((l) => l.name === "tool")).toBeUndefined();
  });

  it("truncates every layer snippet to 500 chars", () => {
    const big: ChatMessage[] = [
      { role: "system", content: "s".repeat(2000) },
      { role: "user", content: "u".repeat(2000) },
    ];
    const ev = buildContextInspectEvent({ messages: big, tools: TOOLS, turn: 0 });
    for (const layer of ev.layers) {
      expect(layer.contentSnippet.length).toBeLessThanOrEqual(500);
    }
  });

  it("labels a memory-in-loop live block as a 'working' layer, plain recall as 'semantic'", () => {
    const live: ChatMessage[] = [
      { role: "system", content: "base system prompt text" },
      { role: "system", content: "--- Live memory (refreshed for the current step) ---\nfresh ctx" },
      { role: "user", content: "go" },
    ];
    const ev = buildContextInspectEvent({ messages: live, tools: [], turn: 1 });
    expect(ev.layers.find((l) => l.name === "working")).toBeDefined();
  });
});

describe("emitContextInspect — gating & file output", () => {
  let dir: string;
  const ORIG_CWD = process.cwd();
  const ORIG_FLAG = process.env.TACHI_CONTEXT_INSPECT;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tachi-ci-"));
    process.chdir(dir);
    delete process.env.TACHI_CONTEXT_INSPECT;
  });

  afterEach(() => {
    process.chdir(ORIG_CWD);
    rmSync(dir, { recursive: true, force: true });
    if (ORIG_FLAG === undefined) delete process.env.TACHI_CONTEXT_INSPECT;
    else process.env.TACHI_CONTEXT_INSPECT = ORIG_FLAG;
    vi.restoreAllMocks();
  });

  it("writes NOTHING when disabled (default)", async () => {
    await emitContextInspect({ messages: MESSAGES, tools: TOOLS, turn: 0 });
    expect(existsSync(join(dir, ".tachi"))).toBe(false);
  });

  it("writes NOTHING when enabled:false is passed explicitly", async () => {
    await emitContextInspect({ messages: MESSAGES, tools: TOOLS, turn: 0, enabled: false });
    expect(existsSync(join(dir, ".tachi"))).toBe(false);
  });

  it("writes a JSONL line when enabled:true", async () => {
    await emitContextInspect({ messages: MESSAGES, tools: TOOLS, turn: 2, enabled: true, sessionId: "s1" });
    const ciDir = join(dir, ".tachi", "context-inspect");
    expect(existsSync(ciDir)).toBe(true);
    const files = readdirSync(ciDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.jsonl$/);

    const raw = readFileSync(join(ciDir, files[0]), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    const parsed: ContextInspectEvent = JSON.parse(raw.trim());
    expect(parsed.event).toBe("context_inspect");
    expect(parsed.turn).toBe(2);
    expect(parsed.sessionId).toBe("s1");
    expect(parsed.layers.length).toBeGreaterThan(0);
  });

  it("writes a line when enabled via TACHI_CONTEXT_INSPECT env var", async () => {
    process.env.TACHI_CONTEXT_INSPECT = "1";
    await emitContextInspect({ messages: MESSAGES, tools: TOOLS, turn: 0 });
    const ciDir = join(dir, ".tachi", "context-inspect");
    expect(existsSync(ciDir)).toBe(true);
    expect(readdirSync(ciDir)).toHaveLength(1);
  });

  it("appends — two emits produce two JSONL lines in the same file", async () => {
    await emitContextInspect({ messages: MESSAGES, tools: TOOLS, turn: 0, enabled: true });
    await emitContextInspect({ messages: MESSAGES, tools: TOOLS, turn: 1, enabled: true });
    const ciDir = join(dir, ".tachi", "context-inspect");
    const files = readdirSync(ciDir);
    expect(files).toHaveLength(1);
    const lines = readFileSync(join(ciDir, files[0]), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const turns = lines.map((l) => (JSON.parse(l) as ContextInspectEvent).turn);
    expect(turns).toEqual([0, 1]);
  });

  it("NEVER throws even when the filesystem write fails", async () => {
    // Real fs failure: make `.tachi` a regular FILE, so mkdir(.tachi/context-inspect)
    // fails with ENOTDIR. emit must swallow it and resolve quietly.
    writeFileSync(join(dir, ".tachi"), "i am a file, not a directory");
    await expect(
      emitContextInspect({ messages: MESSAGES, tools: TOOLS, turn: 0, enabled: true }),
    ).resolves.toBeUndefined();
    // And nothing partial was created under it.
    expect(existsSync(join(dir, ".tachi", "context-inspect"))).toBe(false);
  });

  it("NEVER throws when building the event fails (defensive)", async () => {
    // A message with a non-string content shouldn't crash the emitter.
    const bad = [{ role: "system" } as unknown as ChatMessage];
    await expect(
      emitContextInspect({ messages: bad, tools: TOOLS, turn: 0, enabled: true }),
    ).resolves.toBeUndefined();
  });
});
