// src/gateway/__tests__/server.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createGatewayServer } from "../server.js";
import type { AgentEvent } from "../../types.js";

// Fake runtime whose orchestrator emits a step + final via onEvent, then resolves.
const runtime = {
  orchestrator(opts: { onEvent?: (e: AgentEvent) => void }) {
    return {
      run: async (_task: string) => {
        opts.onEvent?.({ type: "step", iteration: 1 });
        opts.onEvent?.({ type: "final", answer: "OK", haltedBy: "final-answer" as const });
        return { answer: "OK", iterations: 1, toolCalls: [], haltedBy: "final-answer" as const };
      },
    };
  },
} as unknown as Parameters<typeof createGatewayServer>[0];

let server: Server;
let base: string;
const AUTH = { Authorization: "Bearer s3cret", "Content-Type": "application/json" };

beforeEach(async () => {
  server = createGatewayServer(runtime, { env: { GATEWAY_TOKEN: "s3cret" }, heartbeatMs: 50 });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => new Promise<void>((r) => server.close(() => r())));

describe("gateway HTTP API", () => {
  it("401s an unauthenticated POST /runs", async () => {
    const res = await fetch(`${base}/runs`, { method: "POST", body: JSON.stringify({ task: "x" }) });
    expect(res.status).toBe(401);
  });

  it("400s a POST /runs with no task", async () => {
    const res = await fetch(`${base}/runs`, { method: "POST", headers: AUTH, body: "{}" });
    expect(res.status).toBe(400);
  });

  it("starts a run (202 + run_id), then reports done with the result", async () => {
    const res = await fetch(`${base}/runs`, { method: "POST", headers: AUTH, body: JSON.stringify({ task: "verify" }) });
    expect(res.status).toBe(202);
    const { run_id } = (await res.json()) as { run_id: string };
    expect(run_id).toMatch(/[0-9a-f-]{36}/);

    // run is fire-and-forget; poll until done
    let state: any;
    for (let i = 0; i < 20; i++) {
      state = await (await fetch(`${base}/runs/${run_id}`, { headers: AUTH })).json();
      if (state.status !== "running") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(state.status).toBe("done");
    expect(state.result).toBe("OK");
  });

  it("streams SSE events including the final event", async () => {
    const { run_id } = (await (await fetch(`${base}/runs`, { method: "POST", headers: AUTH, body: JSON.stringify({ task: "x" }) })).json()) as { run_id: string };
    const res = await fetch(`${base}/runs/${run_id}/events`, { headers: { Authorization: "Bearer s3cret" } });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text(); // stream ends after final
    expect(text).toContain("event: final");
    expect(text).toContain('"answer":"OK"');
  });

  it("404s another tenant's run id", async () => {
    const { run_id } = (await (await fetch(`${base}/runs`, { method: "POST", headers: AUTH, body: JSON.stringify({ task: "x" }) })).json()) as { run_id: string };
    // multi-tenant server where our token maps to 'other', not the creator
    const other = createGatewayServer(runtime, { env: { GATEWAY_TOKENS: "other:t2" } });
    await new Promise<void>((r) => other.listen(0, r));
    const ob = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
    const res = await fetch(`${ob}/runs/${run_id}`, { headers: { Authorization: "Bearer t2" } });
    expect(res.status).toBe(404);
    await new Promise<void>((r) => other.close(() => r()));
  });

  it("DELETE cancels a run", async () => {
    const { run_id } = (await (await fetch(`${base}/runs`, { method: "POST", headers: AUTH, body: JSON.stringify({ task: "x" }) })).json()) as { run_id: string };
    const res = await fetch(`${base}/runs/${run_id}`, { method: "DELETE", headers: AUTH });
    expect(res.status).toBe(202);
  });
});
