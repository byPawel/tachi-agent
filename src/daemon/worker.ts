/**
 * Queue worker — drains the TaskQueue inside the daemon, one task at a time
 * (a single local Ollama brain gains nothing from queue concurrency), with
 * outcome notifications. Pure orchestration glue: the queue, the run function,
 * the notifier, and the drain flag are all injected, so `tick()` is fully
 * deterministic under test. `start()` polls; ticks never overlap (busy guard);
 * notification failures are swallowed (alerting must never wedge the queue).
 */
import type { TaskQueue } from "./queue.js";
import type { RunResult } from "../types.js";

export interface WorkerDeps {
  queue: TaskQueue;
  /**
   * Execute one task to completion (the daemon binds this to runtime.orchestrator(...).run).
   * `driver` is the task's explicit per-task brain (multi-heart) — when set, the daemon
   * resolves that registered driver for this run only; an unknown name throws, which the
   * worker records as a normal failure (fail loudly, no silent fallback).
   */
  runTask: (task: string, driver?: string) => Promise<Pick<RunResult, "answer" | "haltedBy">>;
  /** Push an outcome to the humans (TACHI_NOTIFY targets). Optional. */
  notify?: (text: string) => Promise<void>;
  /** Poll cadence for start(). Default 2000ms (TACHI_QUEUE_POLL_MS in the daemon). */
  pollMs?: number;
  /** When true, the worker claims nothing (daemon drain mode). */
  isDraining?: () => boolean;
}

export interface Worker {
  /** Claim and run at most one due task. Returns true if a task was processed. */
  tick(): Promise<boolean>;
  start(): void;
  stop(): void;
}

export function createWorker(deps: WorkerDeps): Worker {
  let timer: ReturnType<typeof setInterval> | undefined;
  let busy = false;

  const say = async (text: string) => {
    try { await deps.notify?.(text); } catch { /* alerting must never wedge the queue */ }
  };

  const tick = async (): Promise<boolean> => {
    if (deps.isDraining?.()) return false;
    const t = deps.queue.claim();
    if (!t) return false;
    try {
      const res = await deps.runTask(t.task, t.driver);
      if (res.haltedBy === "final-answer") {
        deps.queue.complete(t.id, res.answer);
        await deps.queue.flush();
        await say(`✅ task ${t.id} done (attempt ${t.attempts}/${t.maxAttempts}):\n${res.answer}`);
      } else {
        deps.queue.fail(t.id, `halted: ${res.haltedBy}`);
        await deps.queue.flush();
        const after = deps.queue.get(t.id);
        await say(`⚠️ task ${t.id} halted (${res.haltedBy}) — ${after?.status === "queued" ? "will retry" : "giving up"}`);
      }
    } catch (e) {
      deps.queue.fail(t.id, e instanceof Error ? e.message : String(e));
      await deps.queue.flush();
      const after = deps.queue.get(t.id);
      await say(`⚠️ task ${t.id} failed: ${after?.error} — ${after?.status === "queued" ? "will retry" : "giving up"}`);
    }
    return true;
  };

  return {
    tick,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        if (busy) return; // never overlap ticks
        busy = true;
        void tick().finally(() => { busy = false; });
      }, deps.pollMs ?? 2000);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
