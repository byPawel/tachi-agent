import { describe, it, expect, vi } from "vitest";
import { DokoroMemory, pickSchemaArgs, MAX_RECALL_QUERY_CHARS } from "../dokoro.js";
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
  it("recall discovers session_recall by suffix and calls it with {query,limit,session_id}", async () => {
    const call = vi.fn(async (_name: string, _args: Record<string, unknown>) => "prior context");
    // No explicit sessionId → falls back to the per-day default "tachi-agent-YYYY-MM-DD".
    const mem = new DokoroMemory(host([RECALL], call));
    const out = await mem.recall("verify ADRs");
    expect(call).toHaveBeenCalledTimes(1);
    const [, args] = call.mock.calls[0];
    expect(args).toMatchObject({ query: "verify ADRs", limit: 5 });
    // session_id is now always forwarded when the schema declares it
    expect(args).toHaveProperty("session_id");
    expect(typeof args["session_id"]).toBe("string");
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

  // --- recall query bounding (task text can be arbitrarily long; memoryInLoop
  //     even feeds assistant output back in as the recall focus) ---

  it("bounds an oversized task before sending it as the recall query", async () => {
    const call = vi.fn(async (_name: string, _args: Record<string, unknown>) => "ctx");
    const mem = new DokoroMemory(host([RECALL], call));
    const hugeTask = "find the bug ".repeat(2000); // ~26k chars
    await mem.recall(hugeTask);
    const [, args] = call.mock.calls[0];
    const query = args["query"] as string;
    expect(query.length).toBeLessThanOrEqual(MAX_RECALL_QUERY_CHARS);
    expect(query.startsWith("find the bug")).toBe(true); // head kept, tail dropped
  });

  it("sends a short task through as the query unchanged", async () => {
    const call = vi.fn(async (_name: string, _args: Record<string, unknown>) => "ctx");
    const mem = new DokoroMemory(host([RECALL], call));
    await mem.recall("short task");
    const [, args] = call.mock.calls[0];
    expect(args["query"]).toBe("short task");
  });

  // --- session_id scoping (the bug: recall was global, not per-session) ---

  it("recall passes session_id when the tool schema declares it", async () => {
    // RECALL already has session_id in its properties (see top of file)
    const call = vi.fn(async () => "prior context");
    const mem = new DokoroMemory(host([RECALL], call), { sessionId: "sess-123" });
    const out = await mem.recall("find the login bug");
    expect(call).toHaveBeenCalledWith(
      "dokoro_dokoro_session_recall",
      { query: "find the login bug", limit: 5, session_id: "sess-123" },
      undefined,
    );
    expect(out).toBe("prior context");
  });

  it("recall omits session_id when the tool schema does not declare it (older dokoro)", async () => {
    const RECALL_NO_SESSION_ID: AgentTool = {
      name: "dokoro_dokoro_session_recall",
      description: "recall (legacy schema)",
      parameters: {
        type: "object",
        properties: { query: {}, limit: {} },
        additionalProperties: false,
      },
    };
    const call = vi.fn(async (_name: string, _args: Record<string, unknown>) => "legacy result");
    const mem = new DokoroMemory(host([RECALL_NO_SESSION_ID], call), { sessionId: "sess-456" });
    const out = await mem.recall("find the login bug");
    const [, args] = call.mock.calls[0];
    expect(args).toHaveProperty("query", "find the login bug");
    expect(args).not.toHaveProperty("session_id");
    expect(out).toBe("legacy result");
  });
});

// ── shared_note_append tool fixture ─────────────────────────────────────────
const NOTE_TOOL: AgentTool = {
  name: "dokoro_dokoro_shared_note_append",
  description: "append a working-memory note",
  parameters: {
    type: "object",
    properties: { agent_id: {}, content: {}, note_type: {}, metadata: {} },
    additionalProperties: false,
  },
};

describe("DokoroMemory.note (working-memory scratchpad)", () => {
  it("appends via shared_note_append with agent_id + content + note_type 'scratch'", async () => {
    const call = vi.fn(async (_name: string, _args: Record<string, unknown>) => "ok");
    const mem = new DokoroMemory(host([NOTE_TOOL], call), { sessionId: "s1", aiModel: "qwen" });
    await mem.note({ task: "t", note: "did X" });
    expect(call).toHaveBeenCalledTimes(1);
    const [name, args] = call.mock.calls[0];
    expect(name).toBe("dokoro_dokoro_shared_note_append");
    expect(args).toMatchObject({
      agent_id: "qwen",
      content: "did X",
      note_type: "scratch",
      metadata: { session_id: "s1", task: "t" },
    });
  });

  it("no-ops when shared_note_append is absent", async () => {
    const call = vi.fn(async () => "ok");
    // Host exposes only the recall tool — no note tool
    const mem = new DokoroMemory(host([RECALL], call), { sessionId: "s1" });
    await expect(mem.note({ task: "t", note: "x" })).resolves.toBeUndefined();
    expect(call).not.toHaveBeenCalled();
  });

  it("swallows host.call errors (best-effort; never fail the run)", async () => {
    const call = vi.fn(async () => { throw new Error("dokoro down"); });
    const mem = new DokoroMemory(host([NOTE_TOOL], call), { sessionId: "s1" });
    await expect(mem.note({ task: "t", note: "x" })).resolves.toBeUndefined();
  });
});
