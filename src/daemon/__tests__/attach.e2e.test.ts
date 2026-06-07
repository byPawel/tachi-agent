// src/daemon/__tests__/attach.e2e.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createGatewayServer, type GatewayControls } from "../../gateway/server.js";
import { GatewayClient } from "../../bridge/openclaw/client.js";
import type { AgentEvent } from "../../types.js";

/**
 * Controllable runtime: emits 2 steps, holds the run "running" until `release()`,
 * then emits a 3rd step + final. Crucially it IGNORES abort — modeling a daemon run
 * that keeps going when a *client's* SSE socket drops (a network drop, not a cancel).
 */
function controllableRuntime(): { runtime: Parameters<typeof createGatewayServer>[0]; release: () => void } {
  let releaseFn: () => void = () => {};
  const runtime = {
    orchestrator(opts: { onEvent?: (e: AgentEvent) => void }) {
      return {
        run: async (_task: string) => {
          opts.onEvent?.({ type: "step", iteration: 1 });
          opts.onEvent?.({ type: "step", iteration: 2 });
          await new Promise<void>((resolve) => { releaseFn = resolve; });
          opts.onEvent?.({ type: "step", iteration: 3 });
          opts.onEvent?.({ type: "final", answer: "RECONNECTED", haltedBy: "final-answer" });
          return { answer: "RECONNECTED", iterations: 3, toolCalls: [], haltedBy: "final-answer" as const, costUsd: 0 };
        },
      };
    },
  } as unknown as Parameters<typeof createGatewayServer>[0];
  return { runtime, release: () => releaseFn() };
}

let server: Server;
let base: string;
let controls: GatewayControls;
let release: () => void;

beforeEach(async () => {
  const r = controllableRuntime();
  release = r.release;
  controls = { draining: false, sinks: new Set() };
  server = createGatewayServer(r.runtime, { env: { GATEWAY_TOKEN: "s3cret" }, heartbeatMs: 10_000, controls });
  await new Promise<void>((res) => server.listen(0, res));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => new Promise<void>((res) => {
  server.closeAllConnections?.(); // force-drop any lingering (client-aborted) sockets
  server.close(() => res());
}));

/** Read SSE id-bearing data frames from a stream until `n` are seen, then drop the socket. */
async function consumeThenDrop(url: string, n: number): Promise<number[]> {
  const ac = new AbortController();
  const res = await fetch(url, { headers: { Authorization: "Bearer s3cret" }, signal: ac.signal });
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const dec = new TextDecoder();
  let buf = "";
  const ids: number[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let sep = buf.indexOf("\n\n");
      while (sep !== -1) {
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        if (!/event: heartbeat/.test(block)) {
          const m = /^id: (\d+)$/m.exec(block);
          if (m) ids.push(Number(m[1]));
        }
        sep = buf.indexOf("\n\n");
      }
      if (ids.length >= n) break;
    }
  } finally {
    ac.abort();                        // DROP the SSE connection (network-drop, not a cancel)
    await reader.cancel().catch(() => {});
  }
  return ids;
}

describe("daemon e2e: attach survives an SSE reconnect with no gap/dup", () => {
  it("consumes a few events, drops the socket, then attaches with the last seq and settles on final", async () => {
    const client = new GatewayClient({ baseUrl: base, token: "s3cret" });
    const { runId } = await client.startRun("delegate + reconnect");

    // 1) First connection: consume seq 1,2 (the two steps), then DROP the socket.
    const firstIds = await consumeThenDrop(`${base}/runs/${runId}/events`, 2);
    expect(firstIds).toEqual([1, 2]);

    // The daemon's run is unaffected by the client drop — release it so it finishes.
    release();
    await new Promise((r) => setTimeout(r, 30)); // let step 3 + final buffer (seq 3, 4)

    // 2) Reconnect with Last-Event-ID = 2 → replay seq 3,4 then settle; ids stay contiguous.
    const seen: Array<{ type: string }> = [];
    const seenIds: number[] = [];
    const outcome = await client.attach(runId, {
      lastEventId: 2,
      onEvent: (e) => { seen.push(e); if (e.type === "step") seenIds.push(e.iteration); },
    });

    expect(seen.map((e) => e.type)).toEqual(["step", "final"]); // seq 3 (step) + seq 4 (final)
    expect(outcome).toEqual({ status: "final", answer: "RECONNECTED", error: undefined });

    // No gap and no dup across the boundary: the first connection ended at seq 2,
    // the reconnect picked up exactly at seq 3 (the 3rd step), never re-sending 1 or 2.
    expect(seenIds).toEqual([3]);
  });

  it("a fresh attach from id 0 replays the full history then settles on final", async () => {
    const client = new GatewayClient({ baseUrl: base, token: "s3cret" });
    const { runId } = await client.startRun("x");
    release(); // finish immediately so the whole history is buffered
    await new Promise((r) => setTimeout(r, 30));

    const seen: string[] = [];
    const outcome = await client.attach(runId, { lastEventId: 0, onEvent: (e) => seen.push(e.type) });
    expect(seen).toEqual(["step", "step", "step", "final"]); // seq 1..4, contiguous
    expect(outcome.status).toBe("final");
    expect(outcome.answer).toBe("RECONNECTED");
  });
});

/** Runtime that finishes a run immediately (one step + final) — for the GC sweep test. */
const immediateRuntime = {
  orchestrator(opts: { onEvent?: (e: AgentEvent) => void }) {
    return {
      run: async (_task: string) => {
        opts.onEvent?.({ type: "step", iteration: 1 });
        opts.onEvent?.({ type: "final", answer: "DONE", haltedBy: "final-answer" });
        return { answer: "DONE", iterations: 1, toolCalls: [], haltedBy: "final-answer" as const, costUsd: 0 };
      },
    };
  },
} as unknown as Parameters<typeof createGatewayServer>[0];

describe("daemon TTL/GC actually evicts finished runs from the live gateway", () => {
  it("a completed, unattached run is gone from the registry after a sweep past TTL", async () => {
    let now = 1_000_000;
    const controls: GatewayControls = { draining: false, sinks: new Set() };
    const gcServer = createGatewayServer(immediateRuntime, {
      env: { GATEWAY_TOKEN: "s3cret" },
      controls,
      now: () => now, // injected clock drives the TTL deterministically
    });
    await new Promise<void>((res) => gcServer.listen(0, res));
    const gcBase = `http://127.0.0.1:${(gcServer.address() as AddressInfo).port}`;
    try {
      const client = new GatewayClient({ baseUrl: gcBase, token: "s3cret" });
      const { runId } = await client.startRun("gc me");

      // Let the run complete; never attach an SSE sink → refcount stays 0.
      let state = await client.getStatus(runId);
      for (let i = 0; i < 30 && state.status === "running"; i++) {
        await new Promise((r) => setTimeout(r, 10));
        state = await client.getStatus(runId);
      }
      expect(state.status).toBe("done");

      // Before TTL: a sweep evicts nothing; the run is still queryable.
      expect(controls.collect!(60_000)).toEqual([]);
      expect((await client.getStatus(runId)).status).toBe("done");

      // Advance past the TTL and sweep → the run is evicted and now 404s.
      now += 60_001;
      expect(controls.collect!(60_000)).toEqual([runId]);
      await expect(client.getStatus(runId)).rejects.toMatchObject({ status: 404 });
    } finally {
      await new Promise<void>((res) => { gcServer.closeAllConnections?.(); gcServer.close(() => res()); });
    }
  });
});
