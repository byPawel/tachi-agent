// src/client/__tests__/unified.test.ts
import { describe, it, expect, vi } from "vitest";
import { localClient, createUnifiedClient } from "../unified.js";
import type { AgentEvent, RunResult } from "../../types.js";
import type { AgentRuntime } from "../../runtime.js";

const RESULT: RunResult = {
  answer: "the answer",
  iterations: 2,
  toolCalls: [],
  haltedBy: "final-answer",
  costUsd: 0,
};

/** A fake AgentRuntime whose orchestrator emits a step + final, then resolves. */
function fakeRuntime(): { rt: AgentRuntime; closed: () => boolean } {
  let closed = false;
  const rt = {
    host: {} as never,
    driver: { name: "fake" } as never,
    toolCount: 3,
    orchestrator: (opts?: { onEvent?: (e: AgentEvent) => void }) => ({
      run: async (_text: string) => {
        opts?.onEvent?.({ type: "step", iteration: 1 });
        opts?.onEvent?.({ type: "final", answer: "the answer", haltedBy: "final-answer" });
        return RESULT;
      },
    }),
    close: async () => { closed = true; },
  } as unknown as AgentRuntime;
  return { rt, closed: () => closed };
}

describe("localClient", () => {
  it("drives the in-process runtime, forwards every AgentEvent, returns the RunResult", async () => {
    const { rt } = fakeRuntime();
    const client = localClient(rt);
    const seen: AgentEvent[] = [];

    const result = await client.run("solve x", { onEvent: (e) => seen.push(e) });

    expect(seen.map((e) => e.type)).toEqual(["step", "final"]);
    expect(result.answer).toBe("the answer");
    expect(result.haltedBy).toBe("final-answer");
  });

  it("passes the abort signal through to the orchestrator", async () => {
    let receivedSignal: AbortSignal | undefined;
    const rt = {
      orchestrator: (opts?: { signal?: AbortSignal }) => {
        receivedSignal = opts?.signal;
        return { run: async () => RESULT };
      },
      close: async () => {},
    } as unknown as AgentRuntime;
    const ac = new AbortController();
    await localClient(rt).run("x", { onEvent: () => {}, signal: ac.signal });
    expect(receivedSignal).toBe(ac.signal);
  });

  it("close() tears down the underlying runtime", async () => {
    const { rt, closed } = fakeRuntime();
    await localClient(rt).close();
    expect(closed()).toBe(true);
  });
});

describe("createUnifiedClient", () => {
  it("with no TACHI_DAEMON_URL builds a LOCAL client from the injected buildAgentFromEnv", async () => {
    const { rt } = fakeRuntime();
    const build = vi.fn(async () => rt);
    const client = await createUnifiedClient({}, { buildAgentFromEnv: build });
    expect(build).toHaveBeenCalledOnce();

    const seen: AgentEvent[] = [];
    const result = await client.run("hi", { onEvent: (e) => seen.push(e) });
    expect(result.answer).toBe("the answer");
    expect(seen.map((e) => e.type)).toEqual(["step", "final"]);
  });

  it("with TACHI_DAEMON_URL set builds a REMOTE client (never touches buildAgentFromEnv)", async () => {
    const build = vi.fn(async () => fakeRuntime().rt);
    const client = await createUnifiedClient(
      { TACHI_DAEMON_URL: "http://127.0.0.1:9999", GATEWAY_TOKEN: "tok" },
      { buildAgentFromEnv: build },
    );
    expect(build).not.toHaveBeenCalled();
    expect(typeof client.run).toBe("function");
    expect(typeof client.close).toBe("function");
    await client.close(); // remote close is a no-op; must not throw
  });
});
