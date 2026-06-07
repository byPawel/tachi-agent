// src/bridge/openclaw/__tests__/client.e2e.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createGatewayServer } from "../../../gateway/server.js";
import type { AgentEvent } from "../../../types.js";
import { GatewayClient } from "../client.js";

// Fake runtime: orchestrator emits a step + final via onEvent, then resolves.
const runtime = {
  orchestrator(opts: { onEvent?: (e: AgentEvent) => void }) {
    return {
      run: async (_task: string) => {
        opts.onEvent?.({ type: "step", iteration: 1 });
        opts.onEvent?.({ type: "final", answer: "REAL", haltedBy: "final-answer" as const });
        return { answer: "REAL", iterations: 1, toolCalls: [], haltedBy: "final-answer" as const, costUsd: 0 };
      },
    };
  },
} as unknown as Parameters<typeof createGatewayServer>[0];

let server: Server;
let base: string;

beforeEach(async () => {
  server = createGatewayServer(runtime, { env: { GATEWAY_TOKEN: "s3cret" }, heartbeatMs: 50 });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => new Promise<void>((r) => server.close(() => r())));

describe("OpenClaw bridge against a real gateway", () => {
  it("runAndWait returns the agent's final answer over real HTTP+SSE", async () => {
    const client = new GatewayClient({ baseUrl: base, token: "s3cret" });
    const seen: string[] = [];
    const answer = await client.runAndWait("delegate me", { onEvent: (e) => seen.push(e.type) });
    expect(answer).toBe("REAL");
    expect(seen).toContain("step");
    expect(seen).toContain("final");
  });

  it("startRun then getStatus reports done with the result", async () => {
    const client = new GatewayClient({ baseUrl: base, token: "s3cret" });
    const { runId } = await client.startRun("x");
    let state = await client.getStatus(runId);
    for (let i = 0; i < 20 && state.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 10));
      state = await client.getStatus(runId);
    }
    expect(state.status).toBe("done");
    expect(state.result).toBe("REAL");
  });

  it("rejects a bad token with GatewayHttpError 401", async () => {
    const client = new GatewayClient({ baseUrl: base, token: "wrong" });
    await expect(client.startRun("x")).rejects.toMatchObject({ status: 401 });
  });
});
