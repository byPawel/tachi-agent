// src/gateway/__tests__/sse.test.ts
import { describe, it, expect } from "vitest";
import { formatSse, SSE_HEADERS } from "../sse.js";

describe("formatSse", () => {
  it("formats id + event + JSON data, terminated by a blank line", () => {
    const frame = formatSse({ type: "step", iteration: 2 }, 7);
    expect(frame).toBe(`id: 7\nevent: step\ndata: {"type":"step","iteration":2}\n\n`);
  });

  it("omits the id line when no index is given", () => {
    const frame = formatSse({ type: "heartbeat" });
    expect(frame).toBe(`event: heartbeat\ndata: {"type":"heartbeat"}\n\n`);
  });

  it("declares the event-stream content type", () => {
    expect(SSE_HEADERS["Content-Type"]).toBe("text/event-stream");
  });
});
