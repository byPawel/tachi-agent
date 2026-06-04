import { describe, it, expect, vi } from "vitest";
import { Orchestrator } from "../agent.js";
import type { Driver, ToolHost, Memory, AgentTool, DriverResult } from "../types.js";

const TOOLS: AgentTool[] = [
  {
    name: "tachibot_jury",
    description: "multi-model jury",
    parameters: { type: "object", properties: { question: { type: "string" } } },
  },
];

function fakeHost(call = vi.fn(async () => "jury verdict: yes")): ToolHost {
  return { tools: () => TOOLS, call };
}

/** A Driver that replays a scripted list of results, one per chat() call (last repeats). */
function scriptDriver(script: DriverResult[]): Driver {
  let i = 0;
  return { name: "scripted", chat: async () => script[Math.min(i++, script.length - 1)] };
}

describe("Orchestrator (the pluggable core)", () => {
  it("recalls memory, dispatches a tool, then returns the final answer + logs it", async () => {
    const recall = vi.fn(async () => "previously: user prefers shipping fast");
    const log = vi.fn(async () => {});
    const memory: Memory = { recall, log };
    const call = vi.fn(async () => "jury verdict: ship it");

    const driver = scriptDriver([
      { content: "consulting the jury", toolCalls: [{ name: "tachibot_jury", arguments: { question: "ship?" } }] },
      { content: "Final: ship it.", toolCalls: [] },
    ]);

    const res = await new Orchestrator(driver, fakeHost(call), memory).run("should we ship?");

    // 3rd arg is the optional abort signal (undefined here — no signal was passed to run()).
    expect(recall).toHaveBeenCalledWith("should we ship?", undefined);
    expect(call).toHaveBeenCalledWith("tachibot_jury", { question: "ship?" }, undefined);
    expect(res.answer).toBe("Final: ship it.");
    expect(res.haltedBy).toBe("final-answer");
    expect(res.toolCalls).toEqual([
      { name: "tachibot_jury", args: { question: "ship?" }, result: "jury verdict: ship it" },
    ]);
    expect(log).toHaveBeenCalledWith({ task: "should we ship?", result: "Final: ship it." }, undefined);
  });

  it("HALTs at maxIterations when the driver never stops calling tools", async () => {
    const driver = scriptDriver([{ content: "", toolCalls: [{ name: "tachibot_jury", arguments: {} }] }]);
    const res = await new Orchestrator(driver, fakeHost(), undefined, { maxIterations: 3 }).run("loop");
    expect(res.haltedBy).toBe("max-iterations");
    expect(res.iterations).toBe(3);
  });

  it("feeds back a typed error for an unknown tool and keeps going (no crash)", async () => {
    const call = vi.fn(async () => "should NOT be called");
    const driver = scriptDriver([
      { content: "", toolCalls: [{ name: "tachibot_nope", arguments: {} }] },
      { content: "recovered", toolCalls: [] },
    ]);
    const res = await new Orchestrator(driver, fakeHost(call), undefined).run("call missing tool");
    expect(call).not.toHaveBeenCalled();
    expect(res.toolCalls[0].result).toContain('unknown tool "tachibot_nope"');
    expect(res.answer).toBe("recovered");
  });

  it("works with NO memory (memory is optional)", async () => {
    const driver = scriptDriver([{ content: "direct answer", toolCalls: [] }]);
    const res = await new Orchestrator(driver, fakeHost(), undefined).run("hi");
    expect(res.answer).toBe("direct answer");
    expect(res.haltedBy).toBe("final-answer");
  });

  it("forwards the run's abort signal to host.call (abort-forwarding is reachable, not dead code)", async () => {
    const ac = new AbortController();
    const call = vi.fn(async (_n: string, _a: unknown, signal?: AbortSignal) => {
      expect(signal).toBe(ac.signal);
      return "ok";
    });
    const driver = scriptDriver([
      { content: "", toolCalls: [{ name: "tachibot_jury", arguments: {} }] },
      { content: "done", toolCalls: [] },
    ]);
    await new Orchestrator(driver, fakeHost(call), undefined, { signal: ac.signal }).run("go");
    expect(call).toHaveBeenCalledWith("tachibot_jury", {}, ac.signal);
  });

  it("forwards the run's abort signal to memory recall + log", async () => {
    const ac = new AbortController();
    const recall = vi.fn(async (_t: string, signal?: AbortSignal) => {
      expect(signal).toBe(ac.signal);
      return "";
    });
    const log = vi.fn(async (_e: unknown, signal?: AbortSignal) => {
      expect(signal).toBe(ac.signal);
    });
    const memory: Memory = { recall, log };
    const driver = scriptDriver([{ content: "answer", toolCalls: [] }]);
    await new Orchestrator(driver, fakeHost(), memory, { signal: ac.signal }).run("go");
    expect(recall).toHaveBeenCalledWith("go", ac.signal);
    expect(log).toHaveBeenCalledWith({ task: "go", result: "answer" }, ac.signal);
  });
});
