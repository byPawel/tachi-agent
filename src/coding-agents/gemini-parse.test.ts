// src/coding-agents/gemini-parse.test.ts
import { describe, it, expect } from "vitest";
import { parseGeminiJson, reviewGuard } from "./gemini-parse.js";

describe("parseGeminiJson", () => {
  it("parses a full valid payload: response text + stats carried through", () => {
    const raw = JSON.stringify({
      response: "The code looks correct.",
      stats: {
        models: { "gemini-2.5-pro": { tokens: 1234 } },
        tools: { totalCalls: 4, byName: { read_file: 3, glob: 1 } },
        files: { totalLinesAdded: 0, totalLinesRemoved: 0 },
      },
    });
    const p = parseGeminiJson(raw);
    expect(p.response).toBe("The code looks correct.");
    expect(p.stats?.tools?.totalCalls).toBe(4);
    expect(p.stats?.tools?.byName).toEqual({ read_file: 3, glob: 1 });
    expect(p.stats?.files?.totalLinesAdded).toBe(0);
    expect(p.stats?.models).toEqual({ "gemini-2.5-pro": { tokens: 1234 } });
    expect(p.raw).toBe(raw);
  });

  it("surfaces an error-only payload with response null", () => {
    const raw = JSON.stringify({
      error: { type: "FatalToolExecutionError", message: "quota exceeded", code: 429 },
    });
    const p = parseGeminiJson(raw);
    expect(p.response).toBeNull();
    expect(p.error?.type).toBe("FatalToolExecutionError");
    expect(p.error?.message).toBe("quota exceeded");
    expect(p.error?.code).toBe(429);
  });

  it("never throws on malformed/truncated JSON and preserves raw verbatim", () => {
    const raw = '{"response": "cut off mid-str';
    const p = parseGeminiJson(raw);
    expect(p.response).toBeNull();
    expect(p.raw).toBe(raw);
  });

  it("never throws when JSON parses to an array or a primitive", () => {
    for (const raw of ["[1,2,3]", "42", '"just a string"', "null", "true"]) {
      const p = parseGeminiJson(raw);
      expect(p.response).toBeNull();
      expect(p.raw).toBe(raw);
    }
  });

  it("treats a non-string or empty-string response as null", () => {
    expect(parseGeminiJson(JSON.stringify({ response: 42 })).response).toBeNull();
    expect(parseGeminiJson(JSON.stringify({ response: "" })).response).toBeNull();
    expect(parseGeminiJson(JSON.stringify({})).response).toBeNull();
  });
});

describe("reviewGuard", () => {
  const parsed = (stats?: unknown) =>
    parseGeminiJson(JSON.stringify(stats === undefined ? { response: "ok" } : { response: "ok", stats }));

  it("trips on totalLinesAdded > 0 and says so", () => {
    const g = reviewGuard(parsed({ files: { totalLinesAdded: 7, totalLinesRemoved: 0 } }));
    expect(g.ok).toBe(false);
    expect(g.reason).toMatch(/lines/i);
    expect(g.reason).toContain("7");
  });

  it("trips on totalLinesRemoved > 0", () => {
    const g = reviewGuard(parsed({ files: { totalLinesAdded: 0, totalLinesRemoved: 3 } }));
    expect(g.ok).toBe(false);
    expect(g.reason).toMatch(/lines/i);
  });

  it("trips on a shell tool in byName and names the tool", () => {
    const g = reviewGuard(parsed({ tools: { totalCalls: 5, byName: { run_shell_command: 5 } } }));
    expect(g.ok).toBe(false);
    expect(g.reason).toContain("run_shell_command");
  });

  it("trips on write/edit/replace tools", () => {
    for (const tool of ["write_file", "edit", "replace", "WriteFile"]) {
      const g = reviewGuard(parsed({ tools: { totalCalls: 1, byName: { [tool]: 1 } } }));
      expect(g.ok, `expected ${tool} to trip the guard`).toBe(false);
      expect(g.reason).toContain(tool);
    }
  });

  it("passes clean read-only usage", () => {
    const g = reviewGuard(parsed({
      tools: { totalCalls: 6, byName: { read_file: 3, glob: 1, grep: 1, web_fetch: 1, google_web_search: 1 } },
      files: { totalLinesAdded: 0, totalLinesRemoved: 0 },
    }));
    expect(g.ok).toBe(true);
  });

  it("passes when stats are missing entirely, with an explicit reason", () => {
    const g = reviewGuard(parsed());
    expect(g.ok).toBe(true);
    expect(g.reason).toBe("no stats present");
  });
});
