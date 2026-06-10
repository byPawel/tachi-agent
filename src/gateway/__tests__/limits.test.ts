import { describe, it, expect, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { createGatewayServer } from "../server.js";

const fakeRuntime = {
  orchestrator: () => ({
    run: async () => ({ answer: "ok", iterations: 1, toolCalls: [], haltedBy: "final-answer" as const, costUsd: 0 }),
  }),
} as any;

let server: ReturnType<typeof createGatewayServer> | undefined;
afterEach(() => server?.close());

async function listen(opts: Parameters<typeof createGatewayServer>[1]) {
  server = createGatewayServer(fakeRuntime, { env: { GATEWAY_TOKEN: "t" }, ...opts });
  await new Promise<void>((r) => server!.listen(0, r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

describe("gateway limit options", () => {
  it("rejects a task longer than maxTaskChars with 400", async () => {
    const base = await listen({ maxTaskChars: 10 });
    const res = await fetch(`${base}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
      body: JSON.stringify({ task: "x".repeat(11) }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe("task too long");
  });

  it("rejects a body larger than maxBodyBytes with 413", async () => {
    const base = await listen({ maxBodyBytes: 100 });
    const res = await fetch(`${base}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
      body: JSON.stringify({ task: "x".repeat(200) }),
    });
    expect(res.status).toBe(413);
  });
});
