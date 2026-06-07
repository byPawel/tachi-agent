// src/daemon/__tests__/session-store.test.ts
import { describe, it, expect } from "vitest";
import { SessionStore } from "../session-store.js";

describe("SessionStore", () => {
  it("creates a running session and tracks it by id", () => {
    const store = new SessionStore();
    const s = store.create("alice", "do X");
    expect(s.id).toMatch(/[0-9a-f-]{36}/);
    expect(s.tenant).toBe("alice");
    expect(s.status).toBe("running");
    expect(s.refcount).toBe(0);
    expect(store.get(s.id)).toBe(s);
    expect(store.size).toBe(1);
  });

  it("append assigns a strictly-increasing seq and respects the ring cap", () => {
    const store = new SessionStore({ bufferMax: 3 });
    const s = store.create("a", "t");
    for (let i = 1; i <= 5; i++) expect(store.append(s.id, { type: "step", iteration: i })).toBe(i);
    expect(store.maxSeq(s.id)).toBe(5);
    expect(store.minSeq(s.id)).toBe(3); // 1,2 evicted past cap 3
    expect(store.eventsAfter(s.id, 0).map((e) => e.seq)).toEqual([3, 4, 5]);
  });

  it("refcount inc/dec tracks attached clients (floored at 0)", () => {
    const store = new SessionStore();
    const s = store.create("a", "t");
    expect(store.incRef(s.id)).toBe(1);
    expect(store.incRef(s.id)).toBe(2);
    expect(store.decRef(s.id)).toBe(1);
    expect(store.decRef(s.id)).toBe(0);
    expect(store.decRef(s.id)).toBe(0);
  });

  it("GC evicts only refcount==0 && status!=running && idle>TTL", () => {
    let now = 1000;
    const store = new SessionStore({ now: () => now });
    const idle = store.create("a", "done-and-idle");
    store.finish(idle.id, "done");

    const running = store.create("a", "still-running"); // status running → never GC'd
    const attached = store.create("a", "attached");
    store.finish(attached.id, "done");
    store.incRef(attached.id); // refcount>0 → never GC'd

    now = 1000 + 60_000 + 1; // advance past a 60s TTL
    const evicted = store.collect(60_000);

    expect(evicted).toEqual([idle.id]); // only the idle, finished, unattached one
    expect(store.get(idle.id)).toBeUndefined();
    expect(store.get(running.id)).toBeDefined();
    expect(store.get(attached.id)).toBeDefined();
  });

  it("GC does NOT evict a finished+idle session before its TTL elapses", () => {
    let now = 1000;
    const store = new SessionStore({ now: () => now });
    const s = store.create("a", "t");
    store.finish(s.id, "done");
    now = 1000 + 30_000; // only 30s < 60s TTL
    expect(store.collect(60_000)).toEqual([]);
    expect(store.get(s.id)).toBeDefined();
  });

  it("touch / append refresh lastActivity so an active-but-finished session survives", () => {
    let now = 1000;
    const store = new SessionStore({ now: () => now });
    const s = store.create("a", "t");
    store.finish(s.id, "done");
    now = 1000 + 59_000;
    store.touch(s.id); // recent activity (e.g. a late attach/poll)
    now = 1000 + 59_000 + 30_000; // 30s since the touch < 60s TTL
    expect(store.collect(60_000)).toEqual([]);
  });

  it("finish records terminal status and result", () => {
    const store = new SessionStore();
    const s = store.create("a", "t");
    store.finish(s.id, "done", { answer: "OK", iterations: 1, toolCalls: [], haltedBy: "final-answer", costUsd: 0 });
    expect(s.status).toBe("done");
    expect(s.result?.answer).toBe("OK");
  });
});
