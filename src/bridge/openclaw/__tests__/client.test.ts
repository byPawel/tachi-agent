// src/bridge/openclaw/__tests__/client.test.ts
import { describe, it, expect } from "vitest";
import { GatewayClient, GatewayHttpError } from "../client.js";
import { formatSse } from "../../../gateway/sse.js";
import type { AgentEvent } from "../../../types.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("GatewayClient.startRun", () => {
  it("POSTs /runs with bearer auth + task and returns the run id", async () => {
    let url = "";
    let init: RequestInit | undefined;
    const fetchImpl = (async (u: string, i?: RequestInit) => {
      url = u;
      init = i;
      return jsonResponse(202, { run_id: "abc-123", status: "running" });
    }) as unknown as typeof fetch;

    const client = new GatewayClient({ baseUrl: "http://gw:8787/", token: "tok", fetchImpl });
    const started = await client.startRun("do a thing", { maxIterations: 7 });

    expect(url).toBe("http://gw:8787/runs"); // trailing slash trimmed
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(JSON.parse(init?.body as string)).toEqual({ task: "do a thing", maxIterations: 7 });
    expect(started).toEqual({ runId: "abc-123", status: "running" });
  });

  it("throws GatewayHttpError on a 429", async () => {
    const fetchImpl = (async () => jsonResponse(429, { error: "too many concurrent runs" })) as unknown as typeof fetch;
    const client = new GatewayClient({ baseUrl: "http://gw", token: "t", fetchImpl });
    await expect(client.startRun("x")).rejects.toBeInstanceOf(GatewayHttpError);
  });
});

describe("GatewayClient.getStatus", () => {
  it("GETs /runs/:id and maps result/status", async () => {
    let url = "";
    const fetchImpl = (async (u: string) => {
      url = u;
      return jsonResponse(200, { run_id: "abc-123", status: "done", result: "the answer", error: undefined });
    }) as unknown as typeof fetch;
    const client = new GatewayClient({ baseUrl: "http://gw", token: "t", fetchImpl });

    const state = await client.getStatus("abc-123");
    expect(url).toBe("http://gw/runs/abc-123");
    expect(state).toEqual({ runId: "abc-123", status: "done", result: "the answer", error: undefined });
  });
});

describe("GatewayClient.cancel", () => {
  it("DELETEs /runs/:id and reports aborted", async () => {
    let method = "";
    const fetchImpl = (async (_u: string, i?: RequestInit) => {
      method = i?.method ?? "GET";
      return jsonResponse(202, { run_id: "abc-123", status: "aborted" });
    }) as unknown as typeof fetch;
    const client = new GatewayClient({ baseUrl: "http://gw", token: "t", fetchImpl });

    const state = await client.cancel("abc-123");
    expect(method).toBe("DELETE");
    expect(state.status).toBe("aborted");
  });
});

/** Build a fetch Response whose body streams the given SSE text in N chunks. */
function sseResponse(frames: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

describe("GatewayClient.streamEvents", () => {
  it("streams agent events to onEvent and resolves with the final answer", async () => {
    const frames = [
      formatSse({ type: "step", iteration: 1 }, 0),
      formatSse({ type: "tool-result", name: "tachibot_tachi", result: "ok" }, 1),
      formatSse({ type: "final", answer: "the answer", haltedBy: "final-answer" }, 2),
    ];
    const fetchImpl = (async () => sseResponse(frames)) as unknown as typeof fetch;
    const client = new GatewayClient({ baseUrl: "http://gw", token: "t", fetchImpl });

    const seen: AgentEvent[] = [];
    const outcome = await client.streamEvents("rid", (e) => seen.push(e));

    expect(seen.map((e) => e.type)).toEqual(["step", "tool-result", "final"]);
    expect(outcome).toEqual({ status: "final", answer: "the answer", error: undefined });
  });

  it("resolves with an error outcome when the stream emits an error event", async () => {
    const fetchImpl = (async () =>
      sseResponse([formatSse({ type: "error", message: "boom" })])) as unknown as typeof fetch;
    const client = new GatewayClient({ baseUrl: "http://gw", token: "t", fetchImpl });

    const outcome = await client.streamEvents("rid", () => {});
    expect(outcome).toEqual({ status: "error", answer: undefined, error: "boom" });
  });

  it("ignores heartbeat frames (does not forward them as agent events)", async () => {
    const frames = [
      formatSse({ type: "heartbeat" }),
      formatSse({ type: "final", answer: "done", haltedBy: "final-answer" }, 0),
    ];
    const fetchImpl = (async () => sseResponse(frames)) as unknown as typeof fetch;
    const client = new GatewayClient({ baseUrl: "http://gw", token: "t", fetchImpl });

    const seen: string[] = [];
    await client.streamEvents("rid", (e) => seen.push(e.type));
    expect(seen).toEqual(["final"]); // heartbeat filtered out
  });
});

describe("GatewayClient.runAndWait", () => {
  it("starts a run, streams it, and returns the final answer", async () => {
    let calls = 0;
    const fetchImpl = (async (u: string) => {
      calls++;
      if (u.endsWith("/runs")) return jsonResponse(202, { run_id: "rid", status: "running" });
      // /runs/rid/events
      return sseResponse([formatSse({ type: "final", answer: "42", haltedBy: "final-answer" }, 0)]);
    }) as unknown as typeof fetch;

    const client = new GatewayClient({ baseUrl: "http://gw", token: "t", fetchImpl });
    const answer = await client.runAndWait("what is the answer");
    expect(answer).toBe("42");
    expect(calls).toBe(2); // POST then SSE GET
  });

  it("throws GatewayHttpError when the run ends in an error event", async () => {
    const fetchImpl = (async (u: string) => {
      if (u.endsWith("/runs")) return jsonResponse(202, { run_id: "rid", status: "running" });
      return sseResponse([formatSse({ type: "error", message: "model down" })]);
    }) as unknown as typeof fetch;
    const client = new GatewayClient({ baseUrl: "http://gw", token: "t", fetchImpl });
    await expect(client.runAndWait("x")).rejects.toThrow(/model down/);
  });
});
