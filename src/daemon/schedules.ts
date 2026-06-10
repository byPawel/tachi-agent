/**
 * Schedules — recurring task definitions that feed the TaskQueue.
 *
 * Two files, deliberately separate:
 *   - Definitions (HUMAN-EDITED, read-only to us): TACHI_SCHEDULES_FILE ??
 *     ".tachi/schedules.json" — `{ "schedules": [ { "id", "task", "driver"?,
 *     "kind": "daily"|"every", "at"?: "HH:MM", "everyMinutes"?: N } ] }`.
 *     Re-read on EVERY tick, so hand edits apply without a daemon restart.
 *   - State (OURS, machine-written): same path with ".json" → "-state.json"
 *     (default ".tachi/schedules-state.json") — `{ "lastRunAt": { "<id>": ms } }`.
 *     Keeping state out of the definitions file means our writes can never
 *     clobber a human's edits, and a human's edits can never lose our state.
 *
 * Due logic (injectable `now`, LOCAL time): "daily" at "HH:MM" is due when
 * now ≥ today-at-HH:MM and it hasn't run since that moment; "every" with
 * everyMinutes N is due when it never ran or N minutes have elapsed. Firing
 * enqueues the task (driver passes through — explicit multi-heart), records
 * lastRunAt=now, and persists state atomically (tmp + rename, like the queue).
 * Malformed entries are skipped with a stderr warn; tick() never throws —
 * a broken schedules file must not take down the daemon.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { QueueTask, TaskQueue } from "./queue.js";

export interface ScheduleDef {
  id: string;
  task: string;
  driver?: string;
  kind: "daily" | "every";
  at?: string;
  everyMinutes?: number;
}

const AT_RE = /^(\d{1,2}):(\d{2})$/;

/** Validate one raw entry; returns null (with a stderr warn) when malformed. */
function parseDef(raw: unknown): ScheduleDef | null {
  const warn = (why: string) => {
    console.error(`[schedules] skipping malformed schedule (${why}): ${JSON.stringify(raw)}`);
    return null;
  };
  if (typeof raw !== "object" || raw === null) return warn("not an object");
  const d = raw as Record<string, unknown>;
  if (typeof d.id !== "string" || !d.id.trim()) return warn("missing id");
  if (typeof d.task !== "string" || !d.task.trim()) return warn("missing task");
  if (d.driver !== undefined && (typeof d.driver !== "string" || !d.driver.trim())) return warn("driver must be a string");
  if (d.kind === "daily") {
    const m = AT_RE.exec(typeof d.at === "string" ? d.at : "");
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return warn(`invalid at "${String(d.at)}"`);
  } else if (d.kind === "every") {
    if (typeof d.everyMinutes !== "number" || !Number.isFinite(d.everyMinutes) || d.everyMinutes <= 0) {
      return warn(`invalid everyMinutes ${String(d.everyMinutes)}`);
    }
  } else {
    return warn(`unknown kind "${String(d.kind)}"`);
  }
  return {
    id: d.id,
    task: d.task,
    driver: typeof d.driver === "string" ? d.driver : undefined,
    kind: d.kind,
    at: typeof d.at === "string" ? d.at : undefined,
    everyMinutes: typeof d.everyMinutes === "number" ? d.everyMinutes : undefined,
  };
}

export class Schedules {
  private readonly file: string;
  private readonly stateFile: string;
  private readonly now: () => number;
  private defs: ScheduleDef[] = [];
  /** lastRunAt by schedule id; null until first loaded from the state file. */
  private lastRunAt: Record<string, number> | null = null;
  /** Busy guard (same pattern as the worker): an overlapping tick would read stale lastRunAt and double-enqueue. */
  private ticking = false;

  constructor(opts: { file?: string; now?: () => number } = {}) {
    this.file = opts.file ?? process.env.TACHI_SCHEDULES_FILE ?? join(".tachi", "schedules.json");
    this.stateFile = this.file.endsWith(".json")
      ? `${this.file.slice(0, -".json".length)}-state.json`
      : `${this.file}-state.json`;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Re-reads the definitions file (so hand edits apply without restart), enqueues
   * every DUE schedule, records+persists lastRunAt. Returns the enqueued tasks.
   * Malformed defs are skipped with a stderr warn. Never throws. Overlap-guarded:
   * a tick entered while one is still running returns [] immediately (a slow tick
   * + interval pile-up must not fire the same schedule twice off stale state).
   */
  async tick(queue: TaskQueue): Promise<QueueTask[]> {
    if (this.ticking) return [];
    this.ticking = true;
    try {
      await this.readDefs();
      if (this.lastRunAt === null) this.lastRunAt = await this.readState();

      const now = this.now();
      const enqueued: QueueTask[] = [];
      for (const def of this.defs) {
        if (!this.isDue(def, now)) continue;
        enqueued.push(queue.enqueue(def.task, { driver: def.driver }));
        this.lastRunAt[def.id] = now;
      }
      if (enqueued.length) {
        await queue.flush();
        await this.flushState();
      }
      return enqueued;
    } catch (e) {
      console.error(`[schedules] tick failed (continuing): ${e instanceof Error ? e.message : String(e)}`);
      return [];
    } finally {
      this.ticking = false;
    }
  }

  /** Current defs (last read). */
  list(): ScheduleDef[] {
    return [...this.defs];
  }

  private isDue(def: ScheduleDef, now: number): boolean {
    const last = this.lastRunAt?.[def.id];
    if (def.kind === "daily") {
      const m = AT_RE.exec(def.at ?? "")!; // validated by parseDef
      const today = new Date(now);
      today.setHours(Number(m[1]), Number(m[2]), 0, 0); // today at HH:MM, LOCAL time
      const dueAt = today.getTime();
      return now >= dueAt && (last === undefined || last < dueAt);
    }
    // kind === "every" — everyMinutes validated by parseDef
    return last === undefined || now - last >= def.everyMinutes! * 60_000;
  }

  /** Re-read the human-edited definitions file. Missing file → no schedules (no-op). */
  private async readDefs(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch {
      this.defs = []; // missing defs file → nothing scheduled
      return;
    }
    try {
      const parsed = JSON.parse(raw) as { schedules?: unknown[] };
      const list = Array.isArray(parsed.schedules) ? parsed.schedules : [];
      this.defs = list.map(parseDef).filter((d): d is ScheduleDef => d !== null);
    } catch {
      console.error(`[schedules] ${this.file} is not valid JSON — keeping previous definitions`);
    }
  }

  private async readState(): Promise<Record<string, number>> {
    try {
      const parsed = JSON.parse(await readFile(this.stateFile, "utf8")) as { lastRunAt?: Record<string, number> };
      return parsed.lastRunAt && typeof parsed.lastRunAt === "object" ? parsed.lastRunAt : {};
    } catch {
      return {}; // missing/corrupt state → treat everything as never-run
    }
  }

  /** Atomically persist lastRunAt (tmp + rename, like TaskQueue.flush). */
  private async flushState(): Promise<void> {
    await mkdir(dirname(this.stateFile), { recursive: true });
    const tmp = `${this.stateFile}.tmp`;
    await writeFile(tmp, JSON.stringify({ lastRunAt: this.lastRunAt ?? {} }, null, 2), "utf8");
    await rename(tmp, this.stateFile);
  }
}
