/**
 * Bounded in-flight coding workers. Every run_coding_agent call spawns a real
 * OS process; with no cap, a burst of calls (via MCP or the gateway) exhausts
 * CPU, RAM, and file descriptors. This semaphore gates admissions; callers hold
 * a release token and MUST release in a finally.
 */
export interface Semaphore {
  acquire(signal?: AbortSignal): Promise<() => void>;
  readonly active: number;
  readonly queued: number;
}

export function createSemaphore(max: number): Semaphore {
  const limit = Math.max(1, Math.floor(max));
  let active = 0;
  const waiters: Array<{ resolve: (r: () => void) => void; reject: (e: Error) => void; onAbort?: () => void; signal?: AbortSignal }> = [];

  function makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active -= 1;
      pump();
    };
  }

  function pump(): void {
    while (active < limit && waiters.length > 0) {
      const w = waiters.shift()!;
      if (w.signal && w.onAbort) w.signal.removeEventListener("abort", w.onAbort);
      active += 1;
      w.resolve(makeRelease());
    }
  }

  return {
    get active() { return active; },
    get queued() { return waiters.length; },
    acquire(signal?: AbortSignal): Promise<() => void> {
      if (signal?.aborted) return Promise.reject(new Error("coding worker slot acquire aborted"));
      if (active < limit) {
        active += 1;
        return Promise.resolve(makeRelease());
      }
      return new Promise<() => void>((resolve, reject) => {
        const waiter: { resolve: (r: () => void) => void; reject: (e: Error) => void; onAbort?: () => void; signal?: AbortSignal } =
          { resolve, reject, signal };
        const onAbort = (): void => {
          const i = waiters.indexOf(waiter);
          if (i >= 0) waiters.splice(i, 1);
          reject(new Error("coding worker slot acquire aborted"));
        };
        waiter.onAbort = onAbort;
        signal?.addEventListener("abort", onAbort, { once: true });
        waiters.push(waiter);
      });
    },
  };
}

/** Resolve the worker cap from env (TACHI_CODING_MAX_CONCURRENCY), default 3, clamp [1,16]. */
export function resolveCodingConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.TACHI_CODING_MAX_CONCURRENCY);
  if (!Number.isFinite(raw)) return 3;
  return Math.max(1, Math.min(16, Math.floor(raw)));
}
