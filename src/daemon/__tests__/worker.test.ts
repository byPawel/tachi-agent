import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskQueue } from "../queue.js";
import { createWorker } from "../worker.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "tachi-worker-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const openQueue = () => TaskQueue.open({ file: join(dir, "q.json"), now: () => 1000 });

describe("worker tick", () => {
  it("claims, runs, completes, and notifies on success", async () => {
    const queue = await openQueue();
    const t = queue.enqueue("say hi");
    const notes: string[] = [];
    const worker = createWorker({
      queue,
      runTask: async (task) => ({ answer: `ran: ${task}`, haltedBy: "final-answer" }),
      notify: async (text) => { notes.push(text); },
    });

    expect(await worker.tick()).toBe(true); // did work
    expect(queue.get(t.id)?.status).toBe("done");
    expect(queue.get(t.id)?.answer).toBe("ran: say hi");
    expect(notes.length).toBe(1);
    expect(notes[0]).toContain("ran: say hi");
    expect(await worker.tick()).toBe(false); // queue empty
  });

  it("fails the task (with retry) when the run throws, and notifies", async () => {
    const queue = await openQueue();
    const t = queue.enqueue("explode", { maxAttempts: 1 });
    const notes: string[] = [];
    const worker = createWorker({
      queue,
      runTask: async () => { throw new Error("driver down"); },
      notify: async (text) => { notes.push(text); },
    });

    expect(await worker.tick()).toBe(true);
    expect(queue.get(t.id)?.status).toBe("failed");
    expect(queue.get(t.id)?.error).toBe("driver down");
    expect(notes[0]).toContain("driver down");
  });

  it("does nothing while draining", async () => {
    const queue = await openQueue();
    queue.enqueue("anything");
    const worker = createWorker({
      queue,
      runTask: async () => ({ answer: "x", haltedBy: "final-answer" }),
      isDraining: () => true,
    });
    expect(await worker.tick()).toBe(false);
    expect(queue.list()[0].status).toBe("queued"); // untouched
  });

  it("passes the claimed task's driver to runTask (explicit multi-heart)", async () => {
    const queue = await openQueue();
    queue.enqueue("cloud job", { driver: "openai" });
    queue.enqueue("local job");
    const seen: Array<{ task: string; driver?: string }> = [];
    const worker = createWorker({
      queue,
      runTask: async (task, driver) => { seen.push({ task, driver }); return { answer: "ok", haltedBy: "final-answer" }; },
    });

    await worker.tick();
    await worker.tick();
    expect(seen).toEqual([
      { task: "cloud job", driver: "openai" },
      { task: "local job", driver: undefined },
    ]);
  });

  it("inFlight() resolves immediately when no tick is executing", async () => {
    const queue = await openQueue();
    const worker = createWorker({
      queue,
      runTask: async () => ({ answer: "x", haltedBy: "final-answer" }),
    });
    await expect(worker.inFlight()).resolves.toBeUndefined(); // idle → already settled
  });

  it("inFlight() tracks the executing tick past stop(), so drain can await completion + flush", async () => {
    const queue = await openQueue();
    const t = queue.enqueue("slow job");
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const worker = createWorker({
      queue,
      runTask: async () => { await gate; return { answer: "finished late", haltedBy: "final-answer" }; },
      pollMs: 5,
    });

    worker.start();
    while (queue.get(t.id)?.status !== "running") await new Promise((r) => setTimeout(r, 5));
    worker.stop(); // drain: no NEW claims — but the in-flight task must still get to finish

    let settled = false;
    const waiting = worker.inFlight().then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 25));
    expect(settled).toBe(false);                       // still executing → inFlight stays pending

    release();
    await waiting;
    expect(queue.get(t.id)?.status).toBe("done");      // completed, not abandoned as "running"
    expect(queue.get(t.id)?.answer).toBe("finished late");
    const onDisk = JSON.parse(await readFile(join(dir, "q.json"), "utf8")) as { tasks: Array<{ id: string; status: string }> };
    expect(onDisk.tasks.find((x) => x.id === t.id)?.status).toBe("done"); // flushed by the time inFlight settles
  });

  it("treats a halted (non-final-answer) run as a failure so it retries", async () => {
    const queue = await openQueue();
    const t = queue.enqueue("slow", { maxAttempts: 1 });
    const worker = createWorker({
      queue,
      runTask: async () => ({ answer: "[halted: timeout, no final answer produced]", haltedBy: "timeout" }),
    });
    await worker.tick();
    expect(queue.get(t.id)?.status).toBe("failed");
    expect(queue.get(t.id)?.error).toContain("timeout");
  });
});
