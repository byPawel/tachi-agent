// src/gateway/__tests__/registry.test.ts
import { describe, it, expect, vi } from "vitest";
import { RunRegistry } from "../registry.js";

describe("RunRegistry", () => {
  it("creates a running record with an id and a fresh AbortController", () => {
    const reg = new RunRegistry();
    const rec = reg.create("alice", "do X");
    expect(rec.id).toMatch(/[0-9a-f-]{36}/);
    expect(rec.tenant).toBe("alice");
    expect(rec.status).toBe("running");
    expect(rec.controller.signal.aborted).toBe(false);
    expect(reg.get(rec.id)).toBe(rec);
  });

  it("appends events and notifies subscribers with an index", () => {
    const reg = new RunRegistry();
    const rec = reg.create("alice", "t");
    const seen: Array<[string, number]> = [];
    reg.subscribe(rec.id, (e, i) => seen.push([e.type, i]));
    reg.append(rec.id, { type: "step", iteration: 1 });
    reg.append(rec.id, { type: "heartbeat" });
    expect(rec.events).toHaveLength(2);
    expect(seen).toEqual([["step", 0], ["heartbeat", 1]]);
  });

  it("unsubscribe stops further notifications", () => {
    const reg = new RunRegistry();
    const rec = reg.create("a", "t");
    const cb = vi.fn();
    const off = reg.subscribe(rec.id, cb);
    off();
    reg.append(rec.id, { type: "heartbeat" });
    expect(cb).not.toHaveBeenCalled();
  });

  it("abort() trips the signal and sets status aborted", () => {
    const reg = new RunRegistry();
    const rec = reg.create("a", "t");
    expect(reg.abort(rec.id)).toBe(true);
    expect(rec.controller.signal.aborted).toBe(true);
    expect(rec.status).toBe("aborted");
    expect(reg.abort("nope")).toBe(false);
  });

  it("finish() records status + result; list() filters by tenant", () => {
    const reg = new RunRegistry();
    const a = reg.create("alice", "t");
    reg.create("bob", "t");
    reg.finish(a.id, "done", { answer: "OK", iterations: 1, toolCalls: [], haltedBy: "final-answer", costUsd: 0 });
    expect(a.status).toBe("done");
    expect(a.result?.answer).toBe("OK");
    expect(reg.list("alice").map((r) => r.id)).toEqual([a.id]);
  });
});
