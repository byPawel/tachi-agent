// src/gateway/__tests__/sse.test.ts
import { describe, it, expect } from "vitest";
import { formatSse, SSE_HEADERS } from "../sse.js";

describe("formatSse", () => {
  it("emits id: <seq> (the durable monotonic registry seq, not an array index)", () => {
    const frame = formatSse({ type: "step", iteration: 2 }, 7);
    expect(frame).toBe(`id: 7\nevent: step\ndata: {"type":"step","iteration":2}\n\n`);
  });

  it("a 1-based seq emits id: 1 for the first event (never id: 0 from an index)", () => {
    const frame = formatSse({ type: "step", iteration: 1 }, 1);
    expect(frame.startsWith("id: 1\n")).toBe(true);
  });

  it("omits the id line for heartbeats (no seq given)", () => {
    const frame = formatSse({ type: "heartbeat" });
    expect(frame).toBe(`event: heartbeat\ndata: {"type":"heartbeat"}\n\n`);
  });

  it("declares the event-stream content type", () => {
    expect(SSE_HEADERS["Content-Type"]).toBe("text/event-stream");
  });
});
