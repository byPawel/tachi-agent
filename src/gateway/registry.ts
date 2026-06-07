// src/gateway/registry.ts
import { randomUUID } from "node:crypto";
import type { GatewayEvent, RunRecord, RunStatus, SeqEvent } from "./types.js";
import type { RunResult } from "../types.js";

/** Subscriber callback — receives the event plus its durable monotonic `seq`. */
type Subscriber = (event: GatewayEvent, seq: number) => void;

/** Default ring-buffer cap per run (Last-Event-ID can replay this many events back). */
const DEFAULT_BUFFER_MAX = 10_000;

export interface RunRegistryOptions {
  /** Per-run event ring-buffer cap. Defaults to TACHI_SESSION_BUFFER_MAX ?? 10000. */
  bufferMax?: number;
  /** Injectable clock (ms) for deterministic TTL/GC tests. Defaults to Date.now. */
  now?: () => number;
}

export class RunRegistry {
  private runs = new Map<string, RunRecord>();
  private subs = new Map<string, Set<Subscriber>>();
  /** Live SSE-sink count per run (a connected client). Drives GC + drain. */
  private refs = new Map<string, number>();
  private readonly bufferMax: number;
  private readonly now: () => number;

  constructor(opts: RunRegistryOptions = {}) {
    const envMax = Number(process.env.TACHI_SESSION_BUFFER_MAX);
    this.bufferMax =
      opts.bufferMax ?? (Number.isFinite(envMax) && envMax > 0 ? envMax : DEFAULT_BUFFER_MAX);
    this.now = opts.now ?? Date.now;
  }

  create(tenant: string, task: string): RunRecord {
    const record: RunRecord = {
      id: randomUUID(),
      tenant,
      task,
      status: "running",
      events: [],
      nextSeq: 0,
      lastActivity: this.now(),
      controller: new AbortController(),
    };
    this.runs.set(record.id, record);
    return record;
  }

  get(id: string): RunRecord | undefined {
    return this.runs.get(id);
  }

  list(tenant: string): RunRecord[] {
    return [...this.runs.values()].filter((r) => r.tenant === tenant);
  }

  /**
   * Append an event under a fresh monotonic `seq` (1-based, strictly increasing,
   * never reused even after ring eviction). Pushes onto the bounded ring buffer
   * (evicting the oldest past the cap) and notifies subscribers with `(event, seq)`.
   * Returns the assigned seq (0 if the run is unknown).
   */
  append(id: string, event: GatewayEvent): number {
    const record = this.runs.get(id);
    if (!record) return 0;
    const seq = ++record.nextSeq;
    record.events.push({ seq, event });
    if (record.events.length > this.bufferMax) record.events.shift(); // evict oldest
    record.lastActivity = this.now();
    const set = this.subs.get(id);
    if (set) for (const cb of set) cb(event, seq);
    return seq;
  }

  /** Buffered entries with `seq > after`, in order (drives Last-Event-ID replay). */
  eventsAfter(id: string, after: number): SeqEvent[] {
    const record = this.runs.get(id);
    if (!record) return [];
    return record.events.filter((e) => e.seq > after);
  }

  /** Smallest seq still retained in the ring (0 if no events buffered). */
  minSeq(id: string): number {
    const record = this.runs.get(id);
    if (!record || record.events.length === 0) return 0;
    return record.events[0].seq;
  }

  /** Largest seq assigned so far (0 if no events). Live streaming resumes at max+1. */
  maxSeq(id: string): number {
    const record = this.runs.get(id);
    return record ? record.nextSeq : 0;
  }

  subscribe(id: string, cb: Subscriber): () => void {
    let set = this.subs.get(id);
    if (!set) { set = new Set(); this.subs.set(id, set); }
    set.add(cb);
    return () => { set!.delete(cb); };
  }

  /** Increment the run's live-subscriber refcount; returns the new count. */
  incRef(id: string): number {
    const n = (this.refs.get(id) ?? 0) + 1;
    this.refs.set(id, n);
    const record = this.runs.get(id);
    if (record) record.lastActivity = this.now();
    return n;
  }

  /** Decrement the run's live-subscriber refcount (floored at 0); returns the new count. */
  decRef(id: string): number {
    const n = Math.max(0, (this.refs.get(id) ?? 0) - 1);
    if (n === 0) this.refs.delete(id); else this.refs.set(id, n);
    const record = this.runs.get(id);
    if (record) record.lastActivity = this.now(); // a client just detached — restart the idle clock
    return n;
  }

  /** Current live-subscriber count for a run (0 if none). */
  refcount(id: string): number {
    return this.refs.get(id) ?? 0;
  }

  finish(id: string, status: RunStatus, result?: RunResult, error?: string): void {
    const record = this.runs.get(id);
    if (!record) return;
    record.status = status;
    if (result) record.result = result;
    if (error) record.error = error;
    record.lastActivity = this.now(); // start the TTL/GC idle clock from completion
    this.subs.delete(id); // release subscribers — the run emits no more events
  }

  /**
   * Evict every collectable run and return the ids removed. A run is collectable only
   * when it is simultaneously unattached (`refcount==0`), terminal (`status!=="running"`),
   * and idle past the TTL — so an attached or still-running run is never collected, even
   * when idle. This is the daemon's defense against unbounded ring-buffer accumulation.
   */
  collect(ttlMs: number): string[] {
    const now = this.now();
    const evicted: string[] = [];
    for (const [id, record] of this.runs) {
      const unattached = (this.refs.get(id) ?? 0) === 0;
      const terminal = record.status !== "running";
      const idleTooLong = now - record.lastActivity > ttlMs;
      if (unattached && terminal && idleTooLong) {
        this.runs.delete(id);
        this.subs.delete(id);
        this.refs.delete(id);
        evicted.push(id);
      }
    }
    return evicted;
  }

  /** Count a tenant's currently-running runs (for concurrency caps). */
  runningCount(tenant: string): number {
    let n = 0;
    for (const r of this.runs.values()) if (r.tenant === tenant && r.status === "running") n++;
    return n;
  }

  abort(id: string): boolean {
    const record = this.runs.get(id);
    if (!record) return false;
    record.controller.abort();
    if (record.status === "running") record.status = "aborted";
    return true;
  }
}
