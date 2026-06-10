/**
 * TaskQueue — the daemon's persistent long-horizon work list.
 *
 * A small JSON-file-backed queue (default ".tachi/queue.json", override with
 * TACHI_QUEUE_FILE): enqueue over HTTP (POST /tasks — external cron is the
 * scheduler), the daemon worker claims and runs tasks one at a time, failures
 * retry with exponential backoff up to maxAttempts. Crash-safe: `open()` loads
 * the file and re-queues any task left "running" by a dead daemon (its attempt
 * still counts). Persistence is atomic (tmp + rename); mutators are synchronous
 * and `flush()` writes the current state.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export type QueueTaskStatus = "queued" | "running" | "done" | "failed";

export interface QueueTask {
  id: string;
  task: string;
  status: QueueTaskStatus;
  attempts: number;
  maxAttempts: number;
  createdAt: number;
  updatedAt: number;
  /** Epoch ms before which a queued retry may not be claimed. */
  notBefore: number;
  /**
   * Explicit per-task brain ("multi-heart"): the registered driver name to run
   * this task with (e.g. "openai"). Absent → the daemon's default (TACHI_DRIVER).
   * Unknown/unavailable drivers fail LOUDLY at run time — no silent fallback.
   */
  driver?: string;
  answer?: string;
  error?: string;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 30_000;   // first retry after 30s, then 60s, 120s…
const BACKOFF_CAP_MS = 3_600_000; // …capped at 1h

export class TaskQueue {
  private tasks: QueueTask[] = [];
  private readonly file: string;
  private readonly now: () => number;

  private constructor(opts: { file?: string; now?: () => number }) {
    this.file = opts.file ?? process.env.TACHI_QUEUE_FILE ?? join(".tachi", "queue.json");
    this.now = opts.now ?? Date.now;
  }

  /** Load (or initialize) the queue. Tasks left "running" by a crash re-queue immediately. */
  static async open(opts: { file?: string; now?: () => number } = {}): Promise<TaskQueue> {
    const q = new TaskQueue(opts);
    try {
      const raw = await readFile(q.file, "utf8");
      const parsed = JSON.parse(raw) as { tasks?: QueueTask[] };
      q.tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
    } catch {
      q.tasks = []; // missing or corrupt file → start fresh (corruption is logged by the caller)
    }
    for (const t of q.tasks) {
      if (t.status === "running") { t.status = "queued"; t.notBefore = 0; t.updatedAt = q.now(); }
    }
    return q;
  }

  enqueue(task: string, opts: { maxAttempts?: number; driver?: string } = {}): QueueTask {
    const t: QueueTask = {
      id: randomUUID(),
      task,
      status: "queued",
      attempts: 0,
      maxAttempts: opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      createdAt: this.now(),
      updatedAt: this.now(),
      notBefore: 0,
      ...(opts.driver !== undefined ? { driver: opts.driver } : {}),
    };
    this.tasks.push(t);
    return t;
  }

  /** Next due queued task (FIFO), marked running with its attempt counted. Null when none due. */
  claim(): QueueTask | null {
    const now = this.now();
    const t = this.tasks.find((x) => x.status === "queued" && x.notBefore <= now);
    if (!t) return null;
    t.status = "running";
    t.attempts++;
    t.updatedAt = now;
    return t;
  }

  complete(id: string, answer: string): void {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.status = "done";
    t.answer = answer;
    t.updatedAt = this.now();
  }

  /** Failure: re-queue with exponential backoff, or mark failed once attempts are exhausted. */
  fail(id: string, error: string): void {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.error = error;
    t.updatedAt = this.now();
    if (t.attempts >= t.maxAttempts) {
      t.status = "failed";
    } else {
      t.status = "queued";
      t.notBefore = this.now() + Math.min(BACKOFF_BASE_MS * 2 ** (t.attempts - 1), BACKOFF_CAP_MS);
    }
  }

  get(id: string): QueueTask | undefined {
    return this.tasks.find((x) => x.id === id);
  }

  list(): QueueTask[] {
    return [...this.tasks];
  }

  /** Atomically persist current state (tmp + rename). Callers flush after mutating. */
  async flush(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify({ tasks: this.tasks }, null, 2), "utf8");
    await rename(tmp, this.file);
  }
}
