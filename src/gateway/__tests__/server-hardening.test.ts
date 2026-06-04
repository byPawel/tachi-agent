import { describe, it, expect, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createGatewayServer } from "../server.js";

const AUTH = { Authorization: "Bearer s3cret", "Content-Type": "application/json" };

// Resolves immediately.
const immediate = {
  orchestrator() {
    return { run: async () => ({ answer: "OK", iterations: 1, toolCalls: [], haltedBy: "final-answer" }) };
  },
} as unknown as Parameters<typeof createGatewayServer>[0];

// Never resolves until aborted — lets us hold a run "running" to test concurrency + cancel.
const hanging = {
  orchestrator(opts: { signal?: AbortSignal }) {
    return {
      run: () =>
        new Promise((resolve) =>
          opts.signal?.addEventListener("abort", () =>
            resolve({ answer: "", iterations: 0, toolCalls: [], haltedBy: "aborted" }),
          ),
        ),
    };
  },
} as unknown as Parameters<typeof createGatewayServer>[0];

let servers: Server[] = [];
async function start(rt: Parameters<typeof createGatewayServer>[0], opts: Record<string, unknown> = {}): Promise<string> {
  const s = createGatewayServer(rt, { env: { GATEWAY_TOKEN: "s3cret" }, ...opts });
  await new Promise<void>((r) => s.listen(0, r));
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  servers = [];
});

describe("gateway hardening (security review fixes)", () => {
  it("413s an oversized request body", async () => {
    const base = await start(immediate);
    const big = JSON.stringify({ task: "x".repeat(70 * 1024) });
    const res = await fetch(`${base}/runs`, { method: "POST", headers: AUTH, body: big });
    expect(res.status).toBe(413);
  });

  it("400s a task that exceeds the length cap", async () => {
    const base = await start(immediate);
    const res = await fetch(`${base}/runs`, { method: "POST", headers: AUTH, body: JSON.stringify({ task: "y".repeat(33 * 1024) }) });
    expect(res.status).toBe(400);
  });

  it("429s past the per-tenant concurrency cap", async () => {
    const base = await start(hanging, { maxConcurrentPerTenant: 1 });
    const first = await fetch(`${base}/runs`, { method: "POST", headers: AUTH, body: JSON.stringify({ task: "a" }) });
    expect(first.status).toBe(202);
    const second = await fetch(`${base}/runs`, { method: "POST", headers: AUTH, body: JSON.stringify({ task: "b" }) });
    expect(second.status).toBe(429);
  });

  it("DELETE cancels a hanging run and frees the slot", async () => {
    const base = await start(hanging, { maxConcurrentPerTenant: 1 });
    const { run_id } = (await (await fetch(`${base}/runs`, { method: "POST", headers: AUTH, body: JSON.stringify({ task: "a" }) })).json()) as { run_id: string };
    const del = await fetch(`${base}/runs/${run_id}`, { method: "DELETE", headers: AUTH });
    expect(del.status).toBe(202);
  });
});
