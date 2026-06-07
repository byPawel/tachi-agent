// src/bridge/openclaw/__tests__/client.test.ts
import { describe, it, expect } from "vitest";
import { GatewayClient, GatewayHttpError, remoteClient } from "../client.js";
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

describe("GatewayClient.attach", () => {
  it("sends Last-Event-ID and forwards replayed-then-live events in order", async () => {
    let headers: Record<string, string> | undefined;
    const frames = [
      formatSse({ type: "step", iteration: 2 }, 2),       // replayed
      formatSse({ type: "tool-result", name: "t", result: "ok" }, 3), // replayed
      formatSse({ type: "final", answer: "the answer", haltedBy: "final-answer" }, 4), // live
    ];
    const fetchImpl = (async (_u: string, i?: RequestInit) => {
      headers = i?.headers as Record<string, string>;
      return sseResponse(frames);
    }) as unknown as typeof fetch;
    const client = new GatewayClient({ baseUrl: "http://gw", token: "t", fetchImpl });

    const seen: AgentEvent[] = [];
    const outcome = await client.attach("rid", { lastEventId: 1, onEvent: (e) => seen.push(e) });

    expect(headers?.["Last-Event-ID"]).toBe("1");
    expect(seen.map((e) => e.type)).toEqual(["step", "tool-result", "final"]);
    expect(outcome).toEqual({ status: "final", answer: "the answer", error: undefined });
  });

  it("omits Last-Event-ID when resuming from id 0", async () => {
    let headers: Record<string, string> | undefined;
    const fetchImpl = (async (_u: string, i?: RequestInit) => {
      headers = i?.headers as Record<string, string>;
      return sseResponse([formatSse({ type: "final", answer: "x", haltedBy: "final-answer" }, 1)]);
    }) as unknown as typeof fetch;
    const client = new GatewayClient({ baseUrl: "http://gw", token: "t", fetchImpl });
    await client.attach("rid", { lastEventId: 0, onEvent: () => {} });
    expect(headers?.["Last-Event-ID"]).toBeUndefined();
  });

  it("throws on a non-contiguous live id (gap/dup → continuity break)", async () => {
    // Resume from 1, but the first frame is seq 3 (seq 2 missing) → continuity violation.
    const frames = [
      formatSse({ type: "step", iteration: 3 }, 3),
      formatSse({ type: "final", answer: "x", haltedBy: "final-answer" }, 4),
    ];
    const fetchImpl = (async () => sseResponse(frames)) as unknown as typeof fetch;
    const client = new GatewayClient({ baseUrl: "http://gw", token: "t", fetchImpl });
    await expect(client.attach("rid", { lastEventId: 1, onEvent: () => {} })).rejects.toThrow(/continuity|gap/i);
  });

  it("aborting the signal issues POST /runs/:id/cancel", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const ac = new AbortController();
    const fetchImpl = (async (u: string, i?: RequestInit) => {
      calls.push({ url: u, method: i?.method ?? "GET" });
      if (u.endsWith("/cancel")) return jsonResponse(202, { run_id: "rid", status: "aborted" });
      // events stream: a slow stream that never settles until aborted
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder();
          controller.enqueue(enc.encode(formatSse({ type: "step", iteration: 1 }, 1)));
          (i?.signal as AbortSignal | undefined)?.addEventListener("abort", () => {
            try { controller.close(); } catch { /* already closed */ }
          });
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    const client = new GatewayClient({ baseUrl: "http://gw", token: "t", fetchImpl });

    const p = client.attach("rid", { lastEventId: 0, onEvent: () => { ac.abort(); }, signal: ac.signal });
    await p.catch(() => {});
    expect(calls.some((c) => c.url.endsWith("/runs/rid/cancel") && c.method === "POST")).toBe(true);
  });

  it("treats a `shutdown` frame as a terminal error, never forwarding it through onEvent", async () => {
    const frames = [
      formatSse({ type: "step", iteration: 1 }, 1),
      formatSse({ type: "shutdown", reason: "server draining" }, 2),
    ];
    const fetchImpl = (async () => sseResponse(frames)) as unknown as typeof fetch;
    const client = new GatewayClient({ baseUrl: "http://gw", token: "t", fetchImpl });

    const seen: AgentEvent[] = [];
    const outcome = await client.attach("rid", { lastEventId: 0, onEvent: (e) => seen.push(e) });

    expect(seen.map((e) => e.type)).toEqual(["step"]); // shutdown is NOT forwarded as an AgentEvent
    expect(outcome).toEqual({ status: "error", answer: undefined, error: "server shutting down" });
  });

  it("does NOT false-gap a fresh attach whose oldest available frame was id-shifted by eviction", async () => {
    // lastEventId 0, but the server's oldest surviving replay is seq 5 (1..4 evicted).
    const frames = [
      formatSse({ type: "step", iteration: 5 }, 5),
      formatSse({ type: "step", iteration: 6 }, 6),
      formatSse({ type: "final", answer: "ok", haltedBy: "final-answer" }, 7),
    ];
    const fetchImpl = (async () => sseResponse(frames)) as unknown as typeof fetch;
    const client = new GatewayClient({ baseUrl: "http://gw", token: "t", fetchImpl });

    const seenIds: number[] = [];
    const seen: string[] = [];
    const outcome = await client.attach("rid", {
      lastEventId: 0,
      onEvent: (e) => { seen.push(e.type); if (e.type === "step") seenIds.push(e.iteration); },
    });

    expect(seen).toEqual(["step", "step", "final"]); // anchored to id 5, then 6,7 contiguous — no throw
    expect(seenIds).toEqual([5, 6]);
    expect(outcome).toEqual({ status: "final", answer: "ok", error: undefined });
  });

  it("still throws a continuity gap for a fresh attach AFTER the anchor (a true hole)", async () => {
    // Anchor to 5, then jump to 7 (seq 6 missing) → real gap → throw.
    const frames = [
      formatSse({ type: "step", iteration: 5 }, 5),
      formatSse({ type: "step", iteration: 7 }, 7),
    ];
    const fetchImpl = (async () => sseResponse(frames)) as unknown as typeof fetch;
    const client = new GatewayClient({ baseUrl: "http://gw", token: "t", fetchImpl });
    await expect(client.attach("rid", { lastEventId: 0, onEvent: () => {} })).rejects.toThrow(/continuity|gap/i);
  });
});

describe("remoteClient (UnifiedClient adapter)", () => {
  it("run() does startRun then attach from id 0 and returns a RunResult", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (u: string) => {
      urls.push(u);
      if (u.endsWith("/runs")) return jsonResponse(202, { run_id: "rid", status: "running" });
      return sseResponse([
        formatSse({ type: "step", iteration: 1 }, 1),
        formatSse({ type: "final", answer: "42", haltedBy: "final-answer" }, 2),
      ]);
    }) as unknown as typeof fetch;

    const client = remoteClient("http://gw", "t", fetchImpl);
    const seen: AgentEvent[] = [];
    const result = await client.run("what is the answer", { onEvent: (e) => seen.push(e) });

    expect(urls[0]).toBe("http://gw/runs");
    expect(urls[1]).toBe("http://gw/runs/rid/events");
    expect(seen.map((e) => e.type)).toEqual(["step", "final"]);
    expect(result.answer).toBe("42");
    expect(result.haltedBy).toBe("final-answer");
    await client.close(); // no-op, must not throw
  });

  it("run() throws when the run ends in an error event", async () => {
    const fetchImpl = (async (u: string) => {
      if (u.endsWith("/runs")) return jsonResponse(202, { run_id: "rid", status: "running" });
      return sseResponse([formatSse({ type: "error", message: "model down" })]);
    }) as unknown as typeof fetch;
    const client = remoteClient("http://gw", "t", fetchImpl);
    await expect(client.run("x", { onEvent: () => {} })).rejects.toThrow(/model down/);
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
