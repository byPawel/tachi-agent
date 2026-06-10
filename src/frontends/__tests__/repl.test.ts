/**
 * Tests for the REPL's pure, exported pieces. Command parsing/execution moved
 * to the unified chat layer (chat-commands.ts — tested there); here we cover
 * the REPL-specific surface: the session-aware prompt and persistent history.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatPrompt, historyFilePath, loadHistory, saveHistory, runRepl } from "../repl.js";
import type { Skill } from "../../skills.js";

const RESEARCHER: Skill = {
  name: "researcher",
  description: "grounded research",
  prompt: "Always search.",
  driver: "openai",
};

const CODER: Skill = { name: "coder", description: "", prompt: "Write clean code." };

describe("formatPrompt", () => {
  it("bare session", () => {
    expect(formatPrompt({})).toBe("tachi › ");
  });
  it("driver only", () => {
    expect(formatPrompt({ driver: "openai" })).toBe("tachi [openai] › ");
  });
  it("driver and skill", () => {
    expect(formatPrompt({ driver: "openai", skill: RESEARCHER })).toBe("tachi [openai·researcher] › ");
  });
  it("skill-only shows the skill's effective driver", () => {
    expect(formatPrompt({ skill: RESEARCHER })).toBe("tachi [openai·researcher] › ");
  });
  it("skill without a driver shows just the skill name", () => {
    expect(formatPrompt({ skill: CODER })).toBe("tachi [coder] › ");
  });
  it("session driver wins over the skill's driver (precedence mirror)", () => {
    expect(formatPrompt({ driver: "ollama", skill: RESEARCHER })).toBe("tachi [ollama·researcher] › ");
  });
});

describe("historyFilePath", () => {
  it("lives under ~/.tachi-agent/repl_history", () => {
    expect(historyFilePath("/Users/u")).toBe("/Users/u/.tachi-agent/repl_history");
  });
});

describe("history load/save", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tachi-repl-hist-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("missing file → [] (fail-soft)", async () => {
    expect(await loadHistory(join(dir, "nope", "repl_history"))).toEqual([]);
  });

  it("round-trips lines, skipping blanks", async () => {
    const file = join(dir, "repl_history");
    await saveHistory(["one", "two words", "three"], file);
    expect(await loadHistory(file)).toEqual(["one", "two words", "three"]);
  });

  it("creates the parent directory when saving", async () => {
    const file = join(dir, "deep", "repl_history");
    await saveHistory(["a"], file);
    expect(await loadHistory(file)).toEqual(["a"]);
  });

  it("caps persisted history at 1000 lines, keeping the most recent", async () => {
    const file = join(dir, "repl_history");
    const lines = Array.from({ length: 1200 }, (_, i) => `line-${i}`);
    await saveHistory(lines, file);
    const loaded = await loadHistory(file);
    expect(loaded).toHaveLength(1000);
    expect(loaded[0]).toBe("line-200");
    expect(loaded[999]).toBe("line-1199");
  });

  it("save is fail-soft on IO errors (unwritable parent)", async () => {
    const blocked = join(dir, "blocked");
    await writeFile(blocked, "i am a file, not a dir");
    await expect(saveHistory(["x"], join(blocked, "repl_history"))).resolves.toBeUndefined();
  });

  it("load skips blank lines in the file", async () => {
    const file = join(dir, "repl_history");
    await writeFile(file, "a\n\n  \nb\n");
    expect(await loadHistory(file)).toEqual(["a", "b"]);
  });
});

describe("runRepl", () => {
  it("is exported as the REPL entry point", () => {
    expect(typeof runRepl).toBe("function");
  });
});
