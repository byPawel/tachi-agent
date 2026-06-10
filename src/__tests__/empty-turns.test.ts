import { describe, it, expect } from "vitest";
import { Orchestrator } from "../agent.js";
import type { Driver, ToolHost } from "../types.js";

const emptyDriver: Driver = { name: "fake", chat: async () => ({ content: "", toolCalls: [] }) };
const noHost: ToolHost = { tools: () => [], call: async () => "" };

describe("maxEmptyTurns option", () => {
  it("halts immediately when maxEmptyTurns is 0", async () => {
    const orch = new Orchestrator(emptyDriver, noHost, undefined, { maxEmptyTurns: 0 });
    const res = await orch.run("hi");
    expect(res.haltedBy).toBe("empty-response");
    expect(res.iterations).toBe(1);
  });

  it("defaults to 2 nudges (3 total turns) when unset", async () => {
    const orch = new Orchestrator(emptyDriver, noHost, undefined, {});
    const res = await orch.run("hi");
    expect(res.haltedBy).toBe("empty-response");
    expect(res.iterations).toBe(3); // 1 empty + 2 nudged retries
  });
});
