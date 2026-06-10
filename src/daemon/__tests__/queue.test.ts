import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskQueue } from "../queue.js";

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tachi-queue-"));
  file = join(dir, "queue.json");
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("TaskQueue", () => {
  it("enqueue → claim → complete lifecycle", async () => {
    const q = await TaskQueue.open({ file, now: () => 1000 });
    const t = q.enqueue("do the thing");
    expect(t.status).toBe("queued");

    const claimed = q.claim();
    expect(claimed?.id).toBe(t.id);
    expect(claimed?.status).toBe("running");
    expect(claimed?.attempts).toBe(1);
    expect(q.claim()).toBeNull(); // nothing else queued

    q.complete(t.id, "answer text");
    expect(q.get(t.id)?.status).toBe("done");
    expect(q.get(t.id)?.answer).toBe("answer text");
  });

  it("fail → retries with backoff until maxAttempts, then failed", async () => {
    let now = 1000;
    const q = await TaskQueue.open({ file, now: () => now });
    const t = q.enqueue("flaky", { maxAttempts: 2 });

    q.claim();
    q.fail(t.id, "boom 1");
    expect(q.get(t.id)?.status).toBe("queued");        // retry scheduled
    expect(q.claim()).toBeNull();                       // backoff: notBefore in the future
    now += 30_001;                                      // past first backoff (30s)
    const second = q.claim();
    expect(second?.attempts).toBe(2);

    q.fail(t.id, "boom 2");
    expect(q.get(t.id)?.status).toBe("failed");         // maxAttempts exhausted
    expect(q.get(t.id)?.error).toBe("boom 2");
  });

  it("persists across open() and re-queues interrupted running tasks (crash recovery)", async () => {
    const q1 = await TaskQueue.open({ file, now: () => 1000 });
    const t = q1.enqueue("long job");
    q1.claim(); // running
    await q1.flush();

    const q2 = await TaskQueue.open({ file, now: () => 2000 }); // simulated restart
    const recovered = q2.get(t.id);
    expect(recovered?.status).toBe("queued");           // running → queued on load
    expect(recovered?.attempts).toBe(1);                // the spent attempt still counts
    expect(q2.claim()?.id).toBe(t.id);
  });

  it("claims in FIFO order and skips not-yet-due retries", async () => {
    let now = 1000;
    const q = await TaskQueue.open({ file, now: () => now });
    const a = q.enqueue("a");
    const b = q.enqueue("b");
    expect(q.claim()?.id).toBe(a.id);
    q.fail(a.id, "x");                                  // a re-queued with backoff
    expect(q.claim()?.id).toBe(b.id);                   // b is due, a is not
  });
});
