// src/bridge/openclaw/__tests__/sse-parse.test.ts
import { describe, it, expect } from "vitest";
import { SseFrameParser } from "../sse-parse.js";
import { formatSse } from "../../../gateway/sse.js";

describe("SseFrameParser", () => {
  it("parses one complete frame produced by formatSse", () => {
    const p = new SseFrameParser();
    const frames = p.push(formatSse({ type: "step", iteration: 1 }, 0));
    expect(frames).toEqual([{ event: "step", data: '{"type":"step","iteration":1}' }]);
  });

  it("parses multiple frames in a single chunk", () => {
    const p = new SseFrameParser();
    const chunk =
      formatSse({ type: "step", iteration: 1 }, 0) +
      formatSse({ type: "final", answer: "OK", haltedBy: "final-answer" }, 1);
    const frames = p.push(chunk);
    expect(frames.map((f) => f.event)).toEqual(["step", "final"]);
    expect(frames[1].data).toContain('"answer":"OK"');
  });

  it("buffers a frame split across two chunks and emits it once complete", () => {
    const p = new SseFrameParser();
    const whole = formatSse({ type: "final", answer: "OK", haltedBy: "final-answer" }, 0);
    const cut = Math.floor(whole.length / 2);
    expect(p.push(whole.slice(0, cut))).toEqual([]); // incomplete → nothing yet
    const frames = p.push(whole.slice(cut));
    expect(frames).toEqual([{ event: "final", data: '{"type":"final","answer":"OK","haltedBy":"final-answer"}' }]);
  });

  it("parses a heartbeat frame that carries no id line", () => {
    const p = new SseFrameParser();
    const frames = p.push(formatSse({ type: "heartbeat" }));
    expect(frames).toEqual([{ event: "heartbeat", data: '{"type":"heartbeat"}' }]);
  });

  it("ignores a trailing partial frame until its blank-line terminator arrives", () => {
    const p = new SseFrameParser();
    expect(p.push("event: step\ndata: {}\n")).toEqual([]); // no blank line yet
    expect(p.push("\n")).toEqual([{ event: "step", data: "{}" }]);
  });
});
