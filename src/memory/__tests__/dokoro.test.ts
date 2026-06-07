import { describe, it, expect, vi } from "vitest";
import { DokoroMemory, pickSchemaArgs } from "../dokoro.js";
import type { ToolHost, AgentTool } from "../../types.js";

// Mirrors the REAL dokoro tools as they arrive (double-prefixed under server "dokoro"):
const RECALL: AgentTool = {
  name: "dokoro_dokoro_session_recall",
  description: "recall",
  parameters: { type: "object", properties: { query: {}, limit: {}, session_id: {}, since: {} } },
};
const SUMMARY: AgentTool = {
  name: "dokoro_dokoro_session_summary_add",
  description: "summary add → conversation_summaries (what recall reads)",
  parameters: {
    type: "object",
    properties: { session_id: {}, ai_model: {}, summary: {}, key_topics: {}, key_decisions: {} },
    additionalProperties: false,
  },
};

function host(tools: AgentTool[], call: ToolHost["call"] = vi.fn(async () => "ctx")): ToolHost {
  return { tools: () => tools, call };
}

describe("pickSchemaArgs", () => {
  it("keeps only keys declared in the schema's properties", () => {
    const out = pickSchemaArgs({ properties: { summary: {}, ai_model: {} } }, { summary: "x", ai_model: "m", entry: "drop me" });
    expect(out).toEqual({ summary: "x", ai_model: "m" });
    expect(out).not.toHaveProperty("entry");
  });
  it("drops undefined values", () => {
    expect(pickSchemaArgs({ properties: { a: {}, b: {} } }, { a: 1, b: undefined })).toEqual({ a: 1 });
  });
  it("passes the candidate through when there are no declared properties", () => {
    expect(pickSchemaArgs(undefined, { a: 1 })).toEqual({ a: 1 });
  });
});

describe("DokoroMemory bridge (real dokoro round-trip: summary_add ↔ recall)", () => {
  it("recall discovers session_recall by suffix and calls it with {query,limit}", async () => {
    const call = vi.fn(async () => "prior context");
    const mem = new DokoroMemory(host([RECALL], call));
    const out = await mem.recall("verify ADRs");
    // 3rd arg is the (optional) abort signal — undefined here since no signal was passed.
    expect(call).toHaveBeenCalledWith("dokoro_dokoro_session_recall", { query: "verify ADRs", limit: 5 }, undefined);
    expect(out).toBe("prior context");
  });

  it("recall treats 'no past sessions' as empty", async () => {
    const call = vi.fn(async () => "(no past sessions)");
    const mem = new DokoroMemory(host([RECALL], call));
    expect(await mem.recall("x")).toBe("");
  });

  it("log writes via session_summary_add with session_id, ai_model, summary", async () => {
    const call = vi.fn(async (_name: string, _args: Record<string, unknown>) => "");
    const mem = new DokoroMemory(host([SUMMARY], call), { sessionId: "s1", aiModel: "ollama:qwen3" });
    await mem.log({ task: "ship?", result: "yes" });
    expect(call).toHaveBeenCalledTimes(1);
    const [name, args] = call.mock.calls[0];
    expect(name).toBe("dokoro_dokoro_session_summary_add");
    expect(args).toMatchObject({ session_id: "s1", ai_model: "ollama:qwen3" });
    expect(args.summary).toContain("Task: ship?");
    expect(args.summary).toContain("Result: yes");
    expect(args).not.toHaveProperty("entry");
  });

  it("recall is a no-op when no dokoro server is connected", async () => {
    const mem = new DokoroMemory(host([{ name: "tachibot_jury", description: "", parameters: {} }]));
    expect(await mem.recall("x")).toBe("");
  });

  it("log never throws when the dokoro tool call fails", async () => {
    const call = vi.fn(async () => { throw new Error("dokoro down"); });
    const mem = new DokoroMemory(host([SUMMARY], call));
    await expect(mem.log({ task: "t", result: "r" })).resolves.toBeUndefined();
  });
});
