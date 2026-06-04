import { describe, it, expect, vi } from "vitest";
import { DokoroMemory, pickSchemaArgs } from "../dokoro.js";
import type { ToolHost, AgentTool } from "../../types.js";

// Mirrors the REAL devlog tools as they arrive namespaced under server "dokoro":
const RECALL: AgentTool = {
  name: "dokoro_devlog_session_recall",
  description: "recall",
  parameters: { type: "object", properties: { query: {}, limit: {}, session_id: {}, since: {} } },
};
const LOG: AgentTool = {
  name: "dokoro_devlog_session_log",
  description: "log",
  parameters: { type: "object", properties: { entry: {}, type: {} }, additionalProperties: false },
};

function host(tools: AgentTool[], call: ToolHost["call"] = vi.fn(async () => "ctx")): ToolHost {
  return { tools: () => tools, call };
}

describe("pickSchemaArgs", () => {
  it("keeps only keys declared in the schema's properties", () => {
    const out = pickSchemaArgs({ properties: { entry: {}, type: {} } }, { entry: "x", type: "decision", content: "drop me" });
    expect(out).toEqual({ entry: "x", type: "decision" });
    expect(out).not.toHaveProperty("content");
  });
  it("drops undefined values", () => {
    expect(pickSchemaArgs({ properties: { a: {}, b: {} } }, { a: 1, b: undefined })).toEqual({ a: 1 });
  });
  it("passes the candidate through when there are no declared properties", () => {
    expect(pickSchemaArgs(undefined, { a: 1 })).toEqual({ a: 1 });
  });
});

describe("DokoroMemory bridge (vs real devlog tool names/args)", () => {
  it("discovers dokoro_devlog_session_recall by suffix and calls it with {query,limit}", async () => {
    const call = vi.fn(async () => "prior context");
    const mem = new DokoroMemory(host([RECALL], call));
    const out = await mem.recall("verify ADRs");
    expect(call).toHaveBeenCalledWith("dokoro_devlog_session_recall", { query: "verify ADRs", limit: 5 });
    expect(out).toBe("prior context");
  });

  it("logs via session_log using `entry` (NOT content) and a valid type", async () => {
    const call = vi.fn(async (_name: string, _args: Record<string, unknown>) => "");
    const mem = new DokoroMemory(host([LOG], call));
    await mem.log({ task: "ship?", result: "yes" });
    expect(call).toHaveBeenCalledTimes(1);
    const [name, args] = call.mock.calls[0];
    expect(name).toBe("dokoro_devlog_session_log");
    expect(args).toMatchObject({ type: "decision" });
    expect(args.entry).toContain("Task: ship?");
    expect(args.entry).toContain("Result: yes");
    expect(args).not.toHaveProperty("content"); // additionalProperties:false would reject it
  });

  it("recall is a no-op (\"\") when no dokoro server is connected", async () => {
    const mem = new DokoroMemory(host([{ name: "tachibot_jury", description: "", parameters: {} }]));
    expect(await mem.recall("x")).toBe("");
  });

  it("log never throws when the dokoro tool call fails", async () => {
    const call = vi.fn(async () => { throw new Error("dokoro down"); });
    const mem = new DokoroMemory(host([LOG], call));
    await expect(mem.log({ task: "t", result: "r" })).resolves.toBeUndefined();
  });
});
