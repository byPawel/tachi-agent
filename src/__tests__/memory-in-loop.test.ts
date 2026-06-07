/**
 * memory-in-loop.test.ts
 *
 * Tests for the opt-in memory-in-loop feature in Orchestrator.run().
 * With memoryInLoop unset/false the code path must be byte-identical to before.
 */
import { describe, it, expect, vi } from "vitest";
import { Orchestrator } from "../agent.js";
import type { Driver, ToolHost, Memory, AgentTool, DriverResult, ChatMessage } from "../types.js";

const TOOL: AgentTool = {
  name: "tachibot_jury",
  description: "multi-model jury",
  parameters: { type: "object", properties: { question: { type: "string" } } },
};

function fakeHost(): ToolHost {
  return {
    tools: () => [TOOL],
    call: vi.fn(async () => "jury result"),
  };
}

/** Replay a scripted sequence of DriverResults; last entry repeats when exhausted. */
function scriptDriver(script: DriverResult[]): Driver & { seen: ChatMessage[][] } {
  let i = 0;
  const seen: ChatMessage[][] = [];
  return {
    name: "scripted",
    seen,
    chat: async ({ messages }) => {
      seen.push([...messages]);
      return script[Math.min(i++, script.length - 1)];
    },
  };
}

/** A driver that calls a tool for `toolIterations` turns then gives a final answer. */
function multiStepDriver(toolIterations: number) {
  const script: DriverResult[] = [
    ...Array.from({ length: toolIterations }, () => ({
      content: "calling tool",
      toolCalls: [{ name: "tachibot_jury", arguments: { question: "step?" } }],
    })),
    { content: "Final: done.", toolCalls: [] },
  ];
  return scriptDriver(script);
}

interface FakeMemory {
  recall: ReturnType<typeof vi.fn<(task: string, signal?: AbortSignal) => Promise<string>>>;
  log: ReturnType<typeof vi.fn<(entry: { task: string; result: string }, signal?: AbortSignal) => Promise<void>>>;
  note: ReturnType<typeof vi.fn<(entry: { task: string; note: string }, signal?: AbortSignal) => Promise<void>>>;
}

function fakeMemory(overrides?: Partial<Memory>): FakeMemory & Memory {
  const recall = vi.fn(async (_t: string, _s?: AbortSignal) => "past context");
  const log = vi.fn(async (_e: { task: string; result: string }, _s?: AbortSignal) => {});
  const note = vi.fn(async (_e: { task: string; note: string }, _s?: AbortSignal) => {});
  return { recall, log, note, ...overrides } as FakeMemory & Memory;
}

// ---------------------------------------------------------------------------
// Case 1 — default off: exact same behavior as before, no "Live memory" block
// ---------------------------------------------------------------------------
describe("memory-in-loop: default OFF (no behavior change)", () => {
  it("recall called exactly once (bookend), note never called, log once", async () => {
    const mem = fakeMemory();
    const driver = multiStepDriver(2);

    const res = await new Orchestrator(driver, fakeHost(), mem, {
      // memoryInLoop intentionally NOT set
    }).run("default test");

    expect(res.haltedBy).toBe("final-answer");
    expect(mem.recall).toHaveBeenCalledTimes(1);
    expect(mem.recall).toHaveBeenCalledWith("default test", undefined);
    expect(mem.note!).not.toHaveBeenCalled();
    expect(mem.log).toHaveBeenCalledTimes(1);
  });

  it("messages sent to driver do NOT contain a 'Live memory' block", async () => {
    const mem = fakeMemory();
    const driver = multiStepDriver(2);

    await new Orchestrator(driver, fakeHost(), mem).run("no live block");

    for (const snapshot of driver.seen) {
      for (const msg of snapshot) {
        if (typeof msg.content === "string") {
          expect(msg.content).not.toContain("Live memory");
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Case 2 — memoryInLoop: true, 2 tool iterations then final answer
// ---------------------------------------------------------------------------
describe("memory-in-loop: ON with note-capable Memory", () => {
  it("recall = 3 (1 bookend + 2 per-iteration), note = 2 (one per tool iteration)", async () => {
    const mem = fakeMemory();
    const driver = multiStepDriver(2);

    const res = await new Orchestrator(driver, fakeHost(), mem, {
      memoryInLoop: true,
    }).run("memory test");

    expect(res.haltedBy).toBe("final-answer");
    expect(res.answer).toBe("Final: done.");
    // Bookend recall (1) + 2 per-step refreshes
    expect(mem.recall).toHaveBeenCalledTimes(3);
    // note called once per tool-calling iteration
    expect(mem.note!).toHaveBeenCalledTimes(2);
    // log called once at the end
    expect(mem.log).toHaveBeenCalledTimes(1);
  });

  it("note entries contain 'step 1' and 'step 2' respectively", async () => {
    const mem = fakeMemory();
    const driver = multiStepDriver(2);

    await new Orchestrator(driver, fakeHost(), mem, {
      memoryInLoop: true,
    }).run("step labels test");

    const noteCalls = mem.note!.mock.calls;
    expect(noteCalls[0][0].note).toContain("step 1");
    expect(noteCalls[1][0].note).toContain("step 2");
    // Both note entries reference the task
    expect(noteCalls[0][0].task).toBe("step labels test");
    expect(noteCalls[1][0].task).toBe("step labels test");
  });

  it("a 'Live memory' system message IS present in the driver message snapshots", async () => {
    const mem = fakeMemory();
    const driver = multiStepDriver(2);

    await new Orchestrator(driver, fakeHost(), mem, {
      memoryInLoop: true,
    }).run("live block check");

    // After at least one tool iteration the live block should be visible
    const allMessages = driver.seen.flat();
    const hasLiveBlock = allMessages.some(
      (m) => m.role === "system" && typeof m.content === "string" && m.content.includes("Live memory"),
    );
    expect(hasLiveBlock).toBe(true);
  });

  it("haltedBy is 'final-answer' and answer is returned correctly", async () => {
    const mem = fakeMemory();
    const res = await new Orchestrator(
      multiStepDriver(2),
      fakeHost(),
      mem,
      { memoryInLoop: true },
    ).run("answer check");

    expect(res.haltedBy).toBe("final-answer");
    expect(res.answer).toBe("Final: done.");
  });
});

// ---------------------------------------------------------------------------
// Case 3 — memoryInLoop: true, but Memory has NO note method
// ---------------------------------------------------------------------------
describe("memory-in-loop: ON but Memory has no note method", () => {
  it("no crash, recall is refreshed (called > 1), run completes normally", async () => {
    // Memory without note
    const recall = vi.fn(async () => "ctx");
    const log = vi.fn(async () => {});
    const mem: Memory = { recall, log }; // no .note

    const res = await new Orchestrator(
      multiStepDriver(2),
      fakeHost(),
      mem,
      { memoryInLoop: true },
    ).run("no note method");

    expect(res.haltedBy).toBe("final-answer");
    // bookend + 2 per-step = 3 total
    expect(recall).toHaveBeenCalledTimes(3);
    expect(log).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Case 4 — memoryInLoop: true, but no Memory at all → treated as off
// ---------------------------------------------------------------------------
describe("memory-in-loop: ON but no Memory provided", () => {
  it("no crash, recall never called, run returns final answer", async () => {
    const driver = multiStepDriver(2);

    const res = await new Orchestrator(driver, fakeHost(), undefined, {
      memoryInLoop: true,
    }).run("no memory at all");

    expect(res.haltedBy).toBe("final-answer");
    expect(res.answer).toBe("Final: done.");
    // No memory means no recall calls
  });
});
