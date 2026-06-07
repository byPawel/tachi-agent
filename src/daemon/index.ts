#!/usr/bin/env node
/**
 * tachi-agent daemon — a long-running host for the singleton AgentRuntime and the
 * active sessions, fronted by the existing gateway HTTP/SSE transport.
 *
 * Thin clients (cli/repl/telegram) ATTACH over the gateway instead of each spawning
 * their own runtime (see `createUnifiedClient` + `GatewayClient.attach`). Sessions
 * survive client disconnect/reconnect via the gateway's per-session ring buffer and
 * `Last-Event-ID` replay.
 *
 * Lifecycle:
 *   - Build the runtime ONCE; run a periodic TTL/GC sweep over the gateway's run
 *     registry (reclaims the ring buffers of finished, unattached, idle runs).
 *   - On SIGINT/SIGTERM: DRAIN — reject new runs (503), broadcast a final
 *     `event: shutdown` SSE frame to every live sink, wait for ATTACHED clients'
 *     SSE sinks to clear, then hard-timeout and exit so a hung run can't wedge
 *     shutdown.
 *
 * Config (env):
 *   GATEWAY_TOKEN / GATEWAY_TOKENS  auth (required — refuse to start without it)
 *   TACHI_DAEMON_PORT               listen port (default 8787)
 *   TACHI_SESSION_TTL_MS            idle TTL before an unattached, finished run is GC'd (default 600000)
 *   TACHI_SESSION_BUFFER_MAX        per-run event ring-buffer cap (default 10000)
 */
import { buildAgentFromEnv } from "../runtime.js";
import { createGatewayServer, type GatewayControls } from "../gateway/server.js";
import { formatSse } from "../gateway/sse.js";

const DRAIN_HARD_TIMEOUT_MS = 30_000; // upper bound on how long drain waits for in-flight runs
const DRAIN_POLL_MS = 200;            // how often drain checks whether sinks have cleared

function num(env: string | undefined, fallback: number): number {
  const n = Number(env);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function main(): Promise<void> {
  if (!process.env.GATEWAY_TOKEN && !process.env.GATEWAY_TOKENS) {
    console.error("Refusing to start without auth: set GATEWAY_TOKEN or GATEWAY_TOKENS.");
    process.exit(1);
  }

  const port = num(process.env.TACHI_DAEMON_PORT, 8787);
  const ttlMs = num(process.env.TACHI_SESSION_TTL_MS, 600_000);
  const sessionBufferMax = num(process.env.TACHI_SESSION_BUFFER_MAX, 10_000);

  const runtime = await buildAgentFromEnv(); // singleton — held for the daemon's lifetime
  const controls: GatewayControls = { draining: false, sinks: new Set() };

  // The gateway populates `controls.collect` (a TTL/GC sweep over its run registry).
  const server = createGatewayServer(runtime, { timeoutMs: 120_000, sessionBufferMax, controls });

  // Periodic GC: evict unattached, finished runs idle past the TTL so their ring
  // buffers don't accumulate forever (a completed run is otherwise never reclaimed).
  const gcEvery = Math.max(1_000, Math.min(ttlMs, 60_000)); // sweep at most once/min, at least once/sec
  const gcTimer = setInterval(() => {
    const evicted = controls.collect?.(ttlMs) ?? [];
    if (evicted.length) console.error(`[daemon] GC evicted ${evicted.length} idle run(s)`);
  }, gcEvery);
  gcTimer.unref?.(); // never keep the process alive solely for GC

  let draining = false;
  const drain = async (sig: string): Promise<void> => {
    if (draining) return; // a second signal during drain → ignore (hard timeout still applies)
    draining = true;
    controls.draining = true; // reject new POST /runs with 503
    console.error(`[daemon] ${sig} — draining: rejecting new runs, finishing in-flight…`);

    // Tell every live client we're going down so it can stop waiting / reconnect elsewhere.
    const frame = formatSse({ type: "shutdown", reason: "server draining" });
    for (const sink of controls.sinks) { try { sink.write(frame); } catch { /* sink already gone */ } }

    // Wait for ATTACHED clients' SSE sinks to clear, bounded by a hard timeout. NOTE:
    // this only waits on runs that currently have a live SSE connection — a run executing
    // with NO attached client has no sink here and is not waited on (it continues in the
    // background until it finishes on its own or the hard timeout fires).
    const deadline = Date.now() + DRAIN_HARD_TIMEOUT_MS;
    while (controls.sinks.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, DRAIN_POLL_MS));
    }
    if (controls.sinks.size > 0) {
      console.error(`[daemon] drain hard-timeout — forcing close on ${controls.sinks.size} sink(s)`);
      for (const sink of controls.sinks) { try { sink.end(); } catch { /* noop */ } }
    }

    clearInterval(gcTimer);
    server.close(async () => {
      try { await runtime.close(); } finally { process.exit(0); }
    });
    // Absolute backstop: exit even if server.close never fires its callback.
    setTimeout(() => process.exit(0), 2_000).unref?.();
  };

  process.on("SIGINT", () => void drain("SIGINT"));
  process.on("SIGTERM", () => void drain("SIGTERM"));

  server.listen(port, () =>
    console.error(`tachi-agent daemon on :${port} · ${runtime.toolCount} tools · session TTL ${ttlMs}ms`),
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
