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

  it("appends events with a strictly-increasing 1-based seq (not array index)", () => {
    const reg = new RunRegistry();
    const rec = reg.create("alice", "t");
    const seen: Array<[string, number]> = [];
    reg.subscribe(rec.id, (e, seq) => seen.push([e.type, seq]));
    reg.append(rec.id, { type: "step", iteration: 1 });
    reg.append(rec.id, { type: "heartbeat" });
    reg.append(rec.id, { type: "final", answer: "x", haltedBy: "final-answer" });
    // subscribers get seq 1, 2, 3 — never array-index-derived (0-based)
    expect(seen).toEqual([["step", 1], ["heartbeat", 2], ["final", 3]]);
    expect(reg.maxSeq(rec.id)).toBe(3);
  });

  it("eventsAfter(k) returns only entries with seq > k, each carrying its seq", () => {
    const reg = new RunRegistry();
    const rec = reg.create("a", "t");
    reg.append(rec.id, { type: "step", iteration: 1 }); // seq 1
    reg.append(rec.id, { type: "step", iteration: 2 }); // seq 2
    reg.append(rec.id, { type: "step", iteration: 3 }); // seq 3

    expect(reg.eventsAfter(rec.id, 0).map((x) => x.seq)).toEqual([1, 2, 3]);
    expect(reg.eventsAfter(rec.id, 1).map((x) => x.seq)).toEqual([2, 3]);
    expect(reg.eventsAfter(rec.id, 3)).toEqual([]);
    expect(reg.eventsAfter(rec.id, 1)[0].event).toEqual({ type: "step", iteration: 2 });
  });

  it("minSeq reflects ring-buffer eviction once the cap is exceeded", () => {
    const reg = new RunRegistry({ bufferMax: 3 });
    const rec = reg.create("a", "t");
    for (let i = 1; i <= 5; i++) reg.append(rec.id, { type: "step", iteration: i });
    // cap 3 → only seq 3,4,5 retained; 1,2 evicted
    expect(reg.maxSeq(rec.id)).toBe(5);
    expect(reg.minSeq(rec.id)).toBe(3);
    expect(reg.eventsAfter(rec.id, 0).map((x) => x.seq)).toEqual([3, 4, 5]);
    // asking after an evicted seq still returns what remains (the caller detects the gap)
    expect(reg.eventsAfter(rec.id, 2).map((x) => x.seq)).toEqual([3, 4, 5]);
  });

  it("minSeq/maxSeq are 0 before any event is appended", () => {
    const reg = new RunRegistry();
    const rec = reg.create("a", "t");
    expect(reg.minSeq(rec.id)).toBe(0);
    expect(reg.maxSeq(rec.id)).toBe(0);
    expect(reg.eventsAfter(rec.id, 0)).toEqual([]);
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

  it("refcount: incRef/decRef track live subscribers, floored at 0", () => {
    const reg = new RunRegistry();
    const rec = reg.create("a", "t");
    expect(reg.refcount(rec.id)).toBe(0);
    expect(reg.incRef(rec.id)).toBe(1);
    expect(reg.incRef(rec.id)).toBe(2);
    expect(reg.refcount(rec.id)).toBe(2);
    expect(reg.decRef(rec.id)).toBe(1);
    expect(reg.decRef(rec.id)).toBe(0);
    expect(reg.decRef(rec.id)).toBe(0); // never goes negative
    expect(reg.refcount(rec.id)).toBe(0);
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

  describe("collect() TTL/GC", () => {
    it("evicts only finished + unattached + idle-past-TTL runs", () => {
      let now = 1000;
      const reg = new RunRegistry({ now: () => now });

      const idle = reg.create("a", "done-and-idle");
      reg.finish(idle.id, "done");

      const running = reg.create("a", "still-running"); // status running → never GC'd

      const attached = reg.create("a", "attached");
      reg.finish(attached.id, "done");
      reg.incRef(attached.id); // refcount>0 → never GC'd

      now = 1000 + 60_000 + 1; // advance past a 60s TTL
      const evicted = reg.collect(60_000);

      expect(evicted).toEqual([idle.id]); // only the idle, finished, unattached one
      expect(reg.get(idle.id)).toBeUndefined();
      expect(reg.get(running.id)).toBeDefined();
      expect(reg.get(attached.id)).toBeDefined();
    });

    it("does NOT evict a finished+idle run before its TTL elapses", () => {
      let now = 1000;
      const reg = new RunRegistry({ now: () => now });
      const r = reg.create("a", "t");
      reg.finish(r.id, "done");
      now = 1000 + 30_000; // 30s < 60s TTL
      expect(reg.collect(60_000)).toEqual([]);
      expect(reg.get(r.id)).toBeDefined();
    });

    it("a detached client restarts the idle clock (decRef refreshes lastActivity)", () => {
      let now = 1000;
      const reg = new RunRegistry({ now: () => now });
      const r = reg.create("a", "t");
      reg.finish(r.id, "done");
      reg.incRef(r.id);   // a client attaches
      now = 1000 + 120_000;
      reg.decRef(r.id);   // …then detaches well past the TTL — but decRef refreshes activity
      now = 1000 + 120_000 + 30_000; // only 30s since the detach < 60s TTL
      expect(reg.collect(60_000)).toEqual([]);
      now = 1000 + 120_000 + 60_000 + 1; // now past the TTL since the detach
      expect(reg.collect(60_000)).toEqual([r.id]);
    });

    it("a late event append refreshes the idle clock so an active stream survives", () => {
      let now = 1000;
      const reg = new RunRegistry({ now: () => now });
      const r = reg.create("a", "t");
      reg.finish(r.id, "done");
      now = 1000 + 59_000;
      reg.append(r.id, { type: "heartbeat" }); // late activity
      now = 1000 + 59_000 + 30_000; // 30s since the append < 60s TTL
      expect(reg.collect(60_000)).toEqual([]);
    });

    it("fully removes a collected run's subscribers + refcount (no leak)", () => {
      let now = 1000;
      const reg = new RunRegistry({ now: () => now });
      const r = reg.create("a", "t");
      reg.subscribe(r.id, () => {});
      reg.finish(r.id, "done");
      now = 1000 + 60_001;
      expect(reg.collect(60_000)).toEqual([r.id]);
      // appending to an evicted id is a no-op (returns seq 0), confirming the run is gone.
      expect(reg.append(r.id, { type: "heartbeat" })).toBe(0);
      expect(reg.refcount(r.id)).toBe(0);
    });
  });
});
