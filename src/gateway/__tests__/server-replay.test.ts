// src/gateway/__tests__/server-replay.test.ts
import { describe, it, expect, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createGatewayServer, type GatewayControls } from "../server.js";
import type { AgentEvent } from "../../types.js";

const AUTH = { Authorization: "Bearer s3cret", "Content-Type": "application/json" };

/**
 * Controllable runtime: emits `stepCount` step events synchronously, then holds
 * the run "running" until the test resolves `release()` (or aborts the signal),
 * at which point it emits a `final`. Lets us inspect the buffered seqs and test
 * Last-Event-ID replay against a still-running run.
 */
function controllableRuntime(stepCount: number): {
  runtime: Parameters<typeof createGatewayServer>[0];
  release: () => void;
} {
  let releaseFn: () => void = () => {};
  const runtime = {
    orchestrator(opts: { onEvent?: (e: AgentEvent) => void; signal?: AbortSignal }) {
      return {
        run: async (_task: string) => {
          for (let i = 1; i <= stepCount; i++) opts.onEvent?.({ type: "step", iteration: i });
          await new Promise<void>((resolve) => {
            releaseFn = resolve;
            opts.signal?.addEventListener("abort", () => resolve());
          });
          opts.onEvent?.({ type: "final", answer: "DONE", haltedBy: "final-answer" });
          return { answer: "DONE", iterations: stepCount, toolCalls: [], haltedBy: "final-answer" as const, costUsd: 0 };
        },
      };
    },
  } as unknown as Parameters<typeof createGatewayServer>[0];
  return { runtime, release: () => releaseFn() };
}

let servers: Server[] = [];
async function start(rt: Parameters<typeof createGatewayServer>[0], opts: Record<string, unknown> = {}): Promise<string> {
  const s = createGatewayServer(rt, { env: { GATEWAY_TOKEN: "s3cret" }, heartbeatMs: 10_000, ...opts });
  await new Promise<void>((r) => s.listen(0, r));
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  servers = [];
});

/** Read SSE frames from a stream until `n` `id:`-bearing frames are seen, then abort. */
async function readIdFrames(res: Response, ac: AbortController, n: number): Promise<number[]> {
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
        const m = /^id: (\d+)$/m.exec(block);
        if (m) ids.push(Number(m[1]));
        sep = buf.indexOf("\n\n");
      }
      if (ids.length >= n) break;
    }
  } finally {
    ac.abort();
    await reader.cancel().catch(() => {});
  }
  return ids;
}

describe("gateway Last-Event-ID replay", () => {
  it("replays only seq > Last-Event-ID, never the already-seen ones", async () => {
    const { runtime, release } = controllableRuntime(3);
    const base = await start(runtime);
    const { run_id } = (await (await fetch(`${base}/runs`, { method: "POST", headers: AUTH, body: JSON.stringify({ task: "x" }) })).json()) as { run_id: string };
    await new Promise((r) => setTimeout(r, 20)); // let the 3 steps buffer (seq 1,2,3)

    const ac = new AbortController();
    const res = await fetch(`${base}/runs/${run_id}/events`, {
      headers: { Authorization: "Bearer s3cret", "Last-Event-ID": "1" },
      signal: ac.signal,
    });
    const ids = await readIdFrames(res, ac, 2);
    expect(ids).toEqual([2, 3]); // seq 1 NOT replayed; no skip
    release();
  });

  it("replays-then-streams-live with no dup or skip across the boundary", async () => {
    const { runtime, release } = controllableRuntime(2);
    const base = await start(runtime);
    const { run_id } = (await (await fetch(`${base}/runs`, { method: "POST", headers: AUTH, body: JSON.stringify({ task: "x" }) })).json()) as { run_id: string };
    await new Promise((r) => setTimeout(r, 20)); // seq 1,2 buffered

    const ac = new AbortController();
    const res = await fetch(`${base}/runs/${run_id}/events`, {
      headers: { Authorization: "Bearer s3cret", "Last-Event-ID": "0" },
      signal: ac.signal,
    });
    // Release after connect so the `final` (seq 3) arrives live, right after replayed 1,2.
    setTimeout(release, 30);
    const ids = await readIdFrames(res, ac, 3);
    expect(ids).toEqual([1, 2, 3]); // 1,2 replayed; 3 live — contiguous, no gap/dup
  });

  it("409s a gap when Last-Event-ID precedes the oldest retained seq", async () => {
    const { runtime, release } = controllableRuntime(5);
    // bufferMax 3 → after 5 steps only seq 3,4,5 retained; minSeq=3
    const base = await start(runtime, { sessionBufferMax: 3 });
    const { run_id } = (await (await fetch(`${base}/runs`, { method: "POST", headers: AUTH, body: JSON.stringify({ task: "x" }) })).json()) as { run_id: string };
    await new Promise((r) => setTimeout(r, 20));

    const res = await fetch(`${base}/runs/${run_id}/events`, {
      headers: { Authorization: "Bearer s3cret", "Last-Event-ID": "1" }, // needs seq 2, evicted
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; min_available: number };
    expect(body.error).toMatch(/gap/);
    expect(body.min_available).toBe(3);
    release();
  });

  it("POST /runs/:id/cancel wire-cancels the run (status → aborted)", async () => {
    const { runtime } = controllableRuntime(1);
    const base = await start(runtime);
    const { run_id } = (await (await fetch(`${base}/runs`, { method: "POST", headers: AUTH, body: JSON.stringify({ task: "x" }) })).json()) as { run_id: string };
    const res = await fetch(`${base}/runs/${run_id}/cancel`, { method: "POST", headers: AUTH });
    expect(res.status).toBe(202);
    expect((await res.json() as { status: string }).status).toBe("aborted");

    // The run actually settles aborted (the orchestrator's abort listener resolves it).
    let state: { status: string } = { status: "running" };
    for (let i = 0; i < 30 && state.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 10));
      state = await (await fetch(`${base}/runs/${run_id}`, { headers: AUTH })).json() as { status: string };
    }
    expect(state.status).toBe("aborted");
  });

  it("heartbeat frames carry the run's current seq as the SSE id", async () => {
    const { runtime, release } = controllableRuntime(2); // seq 1,2 buffered, then idle
    const base = await start(runtime, { heartbeatMs: 15 }); // fast heartbeats
    const { run_id } = (await (await fetch(`${base}/runs`, { method: "POST", headers: AUTH, body: JSON.stringify({ task: "x" }) })).json()) as { run_id: string };
    await new Promise((r) => setTimeout(r, 20));

    const ac = new AbortController();
    const res = await fetch(`${base}/runs/${run_id}/events`, {
      headers: { Authorization: "Bearer s3cret", "Last-Event-ID": "2" }, // skip replay → next frame is a heartbeat
      signal: ac.signal,
    });
    // First id-bearing frame is a heartbeat carrying maxSeq (=2).
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    let buf = "";
    let heartbeatId: number | undefined;
    for (let i = 0; i < 50 && heartbeatId === undefined; i++) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let sep = buf.indexOf("\n\n");
      while (sep !== -1) {
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        if (/event: heartbeat/.test(block)) {
          const m = /^id: (\d+)$/m.exec(block);
          if (m) { heartbeatId = Number(m[1]); break; }
        }
        sep = buf.indexOf("\n\n");
      }
    }
    ac.abort();
    await reader.cancel().catch(() => {});
    expect(heartbeatId).toBe(2);
    release();
  });

  it("drain controls: a finished run's SSE adds then removes its sink (net zero)", async () => {
    const controls: GatewayControls = { draining: false, sinks: new Set() };
    const { runtime, release } = controllableRuntime(1);
    const base = await start(runtime, { controls });
    const { run_id } = (await (await fetch(`${base}/runs`, { method: "POST", headers: AUTH, body: JSON.stringify({ task: "x" }) })).json()) as { run_id: string };
    release(); // let the run reach `final` so the SSE stream ends on its own
    await new Promise((r) => setTimeout(r, 20));
    // Consume the full stream — it ends after `final`; the sink is added then removed.
    await (await fetch(`${base}/runs/${run_id}/events`, { headers: { Authorization: "Bearer s3cret" } })).text();
    expect(controls.sinks.size).toBe(0);
  });

  it("drain controls: rejects new runs with 503 once draining", async () => {
    const controls: GatewayControls = { draining: true, sinks: new Set() };
    const { runtime } = controllableRuntime(1);
    const base = await start(runtime, { controls });
    const res = await fetch(`${base}/runs`, { method: "POST", headers: AUTH, body: JSON.stringify({ task: "y" }) });
    expect(res.status).toBe(503);
    expect((await res.json() as { error: string }).error).toMatch(/drain/);
  });

  it("does NOT 409 when Last-Event-ID is exactly minSeq-1 (boundary, no gap)", async () => {
    const { runtime, release } = controllableRuntime(5);
    const base = await start(runtime, { sessionBufferMax: 3 }); // minSeq=3 after 5 steps
    const { run_id } = (await (await fetch(`${base}/runs`, { method: "POST", headers: AUTH, body: JSON.stringify({ task: "x" }) })).json()) as { run_id: string };
    await new Promise((r) => setTimeout(r, 20));

    const ac = new AbortController();
    const res = await fetch(`${base}/runs/${run_id}/events`, {
      headers: { Authorization: "Bearer s3cret", "Last-Event-ID": "2" }, // next needed = 3 = minSeq → OK
      signal: ac.signal,
    });
    expect(res.status).toBe(200);
    const ids = await readIdFrames(res, ac, 3);
    expect(ids).toEqual([3, 4, 5]);
    release();
  });
});
