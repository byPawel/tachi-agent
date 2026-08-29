// src/coding-agents/claude-parse.test.ts
import { describe, it, expect } from "vitest";
import { parseClaudeEnvelope } from "./claude-parse.js";

const PLAN = "# Plan\n\n1. Do the thing\n2. Verify it";

function envelope(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 11535,
    num_turns: 4,
    result: "the answer",
    session_id: "3f9c2a1e-8b4d-4c6f-9e2a-1b7d5c3f8a90",
    total_cost_usd: 0.03,
    usage: {},
    permission_denials: [],
    ...overrides,
  });
}

describe("parseClaudeEnvelope", () => {
  it("extracts the plan from an ExitPlanMode denial, beating the denial string in result", () => {
    const raw = envelope({
      result: "Claude requested permissions to use ExitPlanMode, but you haven't granted it yet.",
      permission_denials: [
        { tool_name: "ExitPlanMode", tool_use_id: "toolu_01", tool_input: { plan: PLAN } },
      ],
    });
    const r = parseClaudeEnvelope(raw);
    expect(r.text).toBe(PLAN);
    expect(r.isError).toBe(false);
    expect(r.deniedCalls).toBe(1);
  });

  it("finds the plan among multiple denials where non-ExitPlanMode entries come first", () => {
    const raw = envelope({
      result: "denied",
      permission_denials: [
        { tool_name: "Bash", tool_use_id: "toolu_01", tool_input: { command: "npm test" } },
        { tool_name: "Write", tool_use_id: "toolu_02", tool_input: { file_path: "/tmp/x" } },
        { tool_name: "ExitPlanMode", tool_use_id: "toolu_03", tool_input: { plan: PLAN } },
      ],
    });
    const r = parseClaudeEnvelope(raw);
    expect(r.text).toBe(PLAN);
    expect(r.deniedCalls).toBe(3);
  });

  it("falls back to result when the ExitPlanMode denial has no usable plan", () => {
    for (const tool_input of [{ plan: null }, {}, { plan: 42 }, { plan: "   " }, null]) {
      const raw = envelope({
        result: "the answer",
        permission_denials: [{ tool_name: "ExitPlanMode", tool_use_id: "toolu_01", tool_input }],
      });
      const r = parseClaudeEnvelope(raw);
      expect(r.text).toBe("the answer");
      expect(r.deniedCalls).toBe(1);
    }
  });

  it("uses result as the text for a clean write run (empty denials)", () => {
    const r = parseClaudeEnvelope(envelope({ result: "done: edited 3 files" }));
    expect(r.text).toBe("done: edited 3 files");
    expect(r.isError).toBe(false);
    expect(r.deniedCalls).toBe(0);
  });

  it("counts denials in a write run while keeping result as the text", () => {
    const raw = envelope({
      result: "partial: could not run tests",
      permission_denials: [
        { tool_name: "Bash", tool_use_id: "toolu_01", tool_input: { command: "npm test" } },
        { tool_name: "Bash", tool_use_id: "toolu_02", tool_input: { command: "git diff" } },
      ],
    });
    const r = parseClaudeEnvelope(raw);
    expect(r.text).toBe("partial: could not run tests");
    expect(r.deniedCalls).toBe(2);
  });

  it("propagates is_error while still extracting text per the normal rules", () => {
    const r = parseClaudeEnvelope(envelope({ is_error: true, subtype: "error_during_execution", result: "ran out of turns" }));
    expect(r.isError).toBe(true);
    expect(r.text).toBe("ran out of turns");
  });

  it("fails closed on malformed JSON, preserving raw verbatim", () => {
    const raw = "not json at all {truncated";
    const r = parseClaudeEnvelope(raw);
    expect(r).toMatchObject({ text: null, isError: true, deniedCalls: 0, raw });
  });

  it("fails closed when the parse result is not a plain object", () => {
    for (const raw of ["[1,2,3]", "\"just a string\"", "42", "null", "true", ""]) {
      const r = parseClaudeEnvelope(raw);
      expect(r.text).toBeNull();
      expect(r.isError).toBe(true);
      expect(r.deniedCalls).toBe(0);
      expect(r.raw).toBe(raw);
    }
  });

  it("counts ALL denial entries even when some are malformed", () => {
    const raw = envelope({
      result: "denied",
      permission_denials: [null, "garbage", { tool_name: "ExitPlanMode", tool_input: { plan: PLAN } }],
    });
    const r = parseClaudeEnvelope(raw);
    expect(r.deniedCalls).toBe(3);
    expect(r.text).toBe(PLAN);
  });

  it("captures sessionId and numTurns when valid", () => {
    const r = parseClaudeEnvelope(envelope({ session_id: "abc-123", num_turns: 7 }));
    expect(r.sessionId).toBe("abc-123");
    expect(r.numTurns).toBe(7);
  });

  it("omits sessionId and numTurns when the wrong type", () => {
    const r = parseClaudeEnvelope(envelope({ session_id: 99, num_turns: "4" }));
    expect(r).not.toHaveProperty("sessionId");
    expect(r).not.toHaveProperty("numTurns");
    const r2 = parseClaudeEnvelope(envelope({ session_id: "", num_turns: NaN }));
    expect(r2).not.toHaveProperty("sessionId");
    expect(r2).not.toHaveProperty("numTurns");
  });

  it("returns text null when neither a plan nor a usable result exists", () => {
    const r = parseClaudeEnvelope(envelope({ result: "", permission_denials: undefined }));
    expect(r.text).toBeNull();
    expect(r.isError).toBe(false);
    expect(r.deniedCalls).toBe(0);
  });
});
