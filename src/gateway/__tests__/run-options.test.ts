import { describe, it, expect, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { createGatewayServer } from "../server.js";

const calls: Array<{ options: any; driver?: string }> = [];
const fakeRuntime = {
  orchestrator: (options: any, driver?: string) => {
    calls.push({ options, driver });
    return { run: async () => ({ answer: "ok", iterations: 1, toolCalls: [], haltedBy: "final-answer" as const, costUsd: 0 }) };
  },
} as any;

let server: ReturnType<typeof createGatewayServer> | undefined;
afterEach(() => { server?.close(); calls.length = 0; });

async function post(body: unknown) {
  server = createGatewayServer(fakeRuntime, { env: { GATEWAY_TOKEN: "t" } });
  await new Promise<void>((r) => server!.listen(0, r));
  const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  return fetch(`${base}/runs`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer t" }, body: JSON.stringify(body) });
}

describe("POST /runs option pass-through", () => {
  it("forwards driver, systemPrompt, allowTools", async () => {
    const res = await post({ task: "x", driver: "openai", systemPrompt: "be brief", allowTools: ["tachibot_jury"] });
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 30));
    expect(calls[0].driver).toBe("openai");
    expect(calls[0].options.systemPrompt).toBe("be brief");
    expect(calls[0].options.allowTools).toEqual(["tachibot_jury"]);
  });
  it("validates: non-string driver → 400; oversized systemPrompt → 400; >64 allowTools → 400", async () => {
    expect((await post({ task: "x", driver: 5 })).status).toBe(400);
    expect((await post({ task: "x", systemPrompt: "p".repeat(16_385) })).status).toBe(400);
    expect((await post({ task: "x", allowTools: Array(65).fill("a") })).status).toBe(400);
  });
});
