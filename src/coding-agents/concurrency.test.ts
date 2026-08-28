import { describe, it, expect } from "vitest";
import { createSemaphore, resolveCodingConcurrency } from "./concurrency.js";

describe("createSemaphore", () => {
  it("allows up to max concurrent holders and queues the rest", async () => {
    const sem = createSemaphore(2);
    const r1 = await sem.acquire();
    const r2 = await sem.acquire();
    expect(sem.active).toBe(2);
    let third = false;
    const p3 = sem.acquire().then((rel) => { third = true; return rel; });
    await Promise.resolve();
    expect(third).toBe(false); // blocked
    expect(sem.queued).toBe(1);
    r1();
    const r3 = await p3;
    expect(third).toBe(true);
    r2(); r3();
    expect(sem.active).toBe(0);
  });

  it("a released slot is idempotent (double-release does not over-admit)", async () => {
    const sem = createSemaphore(1);
    const rel = await sem.acquire();
    rel(); rel();
    expect(sem.active).toBe(0);
  });

  it("rejects a queued acquire when its signal aborts", async () => {
    const sem = createSemaphore(1);
    await sem.acquire();
    const ac = new AbortController();
    const p = sem.acquire(ac.signal);
    ac.abort();
    await expect(p).rejects.toThrow(/abort/i);
    expect(sem.queued).toBe(0);
  });
});

describe("resolveCodingConcurrency", () => {
  it("defaults to 3", () => expect(resolveCodingConcurrency({})).toBe(3));
  it("clamps to [1,16]", () => {
    expect(resolveCodingConcurrency({ TACHI_CODING_MAX_CONCURRENCY: "0" })).toBe(1);
    expect(resolveCodingConcurrency({ TACHI_CODING_MAX_CONCURRENCY: "999" })).toBe(16);
    expect(resolveCodingConcurrency({ TACHI_CODING_MAX_CONCURRENCY: "5" })).toBe(5);
  });
  it("falls back to 3 on garbage", () => expect(resolveCodingConcurrency({ TACHI_CODING_MAX_CONCURRENCY: "abc" })).toBe(3));
});
