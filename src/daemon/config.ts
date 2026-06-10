/** Daemon config helpers — pure, extracted from index.ts so they are unit-testable. */

/** Parse a positive number from env; fail-soft to `fallback` on unset/NaN/non-positive. */
export function num(env: string | undefined, fallback: number): number {
  const n = Number(env);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** GC sweep cadence for a given session TTL: at most once/min, at least once/sec. */
export function gcInterval(ttlMs: number): number {
  return Math.max(1_000, Math.min(ttlMs, 60_000));
}
