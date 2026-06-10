import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createGatewayServer } from "../server.js";
import { RunEventLog } from "../../daemon/eventlog.js";

const fakeRuntime = {
  orchestrator: (options: any) => ({
    run: async () => {
      options?.onEvent?.({ type: "step", iteration: 1 });
      options?.onEvent?.({ type: "final", answer: "done", haltedBy: "final-answer" });
      return { answer: "done", iterations: 1, toolCalls: [], haltedBy: "final-answer", costUsd: 0 };
    },
  }),
} as any;

let dir: string;
let server: ReturnType<typeof createGatewayServer> | undefined;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "tachi-gw-log-")); });
afterEach(async () => { server?.close(); await rm(dir, { recursive: true, force: true }); });

describe("gateway event-log wiring", () => {
  it("persists every run event to the JSONL log", async () => {
    const eventLog = new RunEventLog({ dir, now: () => 1 });
    server = createGatewayServer(fakeRuntime, { env: { GATEWAY_TOKEN: "t" }, eventLog });
    await new Promise<void>((r) => server!.listen(0, r));
    const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;

    const res = await fetch(`${base}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
      body: JSON.stringify({ task: "hello" }),
    });
    expect(res.status).toBe(202);
    const { run_id } = (await res.json()) as { run_id: string };

    let entries: Awaited<ReturnType<typeof eventLog.read>> = [];
    for (let i = 0; i < 50 && entries.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 20));
      entries = await eventLog.read(run_id);
    }
    expect(entries.map((e) => [e.seq, e.event.type])).toEqual([[1, "step"], [2, "final"]]);
  });
});
