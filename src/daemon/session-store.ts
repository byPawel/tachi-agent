// src/daemon/session-store.ts
/**
 * SessionStore — the daemon's in-memory session table.
 *
 * One `Session` per run: a bounded ring buffer of events keyed by a durable
 * monotonic `seq` (so Last-Event-ID replay survives eviction), a live-attach
 * `refcount`, and a `lastActivity` stamp. The GC sweep (`collect`) evicts only
 * sessions that are simultaneously idle past the TTL, unattached, and terminal —
 * an attached or still-running session is never collected, even when idle.
 *
 * NOTE: in-memory only — sessions are lost on daemon restart (persistence is an
 * explicit follow-up, see the v2 plan's council caveat). Zero deps.
 */
import { randomUUID } from "node:crypto";
import type { GatewayEvent, RunStatus, SeqEvent } from "../gateway/types.js";
import type { RunResult } from "../types.js";

const DEFAULT_BUFFER_MAX = 10_000;

export interface Session {
  id: string;
  tenant: string;
  task: string;
  status: RunStatus;
  /** Bounded ring buffer (most-recent events), each tagged with its durable seq. */
  events: SeqEvent[];
  /** Next seq to assign (survives ring eviction). 0 before the first event. */
  nextSeq: number;
  /** Number of live attached clients (SSE sinks). >0 pins the session against GC. */
  refcount: number;
  /** Epoch ms of the last create/append/touch — the GC idle clock. */
  lastActivity: number;
  result?: RunResult;
  error?: string;
  controller: AbortController;
}

export interface SessionStoreOptions {
  /** Per-session event ring-buffer cap. Defaults to TACHI_SESSION_BUFFER_MAX ?? 10000. */
  bufferMax?: number;
  /** Injectable clock (ms) for deterministic GC tests. Defaults to Date.now. */
  now?: () => number;
}

export class SessionStore {
  private sessions = new Map<string, Session>();
  private readonly bufferMax: number;
  private readonly now: () => number;

  constructor(opts: SessionStoreOptions = {}) {
    const envMax = Number(process.env.TACHI_SESSION_BUFFER_MAX);
    this.bufferMax =
      opts.bufferMax ?? (Number.isFinite(envMax) && envMax > 0 ? envMax : DEFAULT_BUFFER_MAX);
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.sessions.size;
  }

  create(tenant: string, task: string): Session {
    const session: Session = {
      id: randomUUID(),
      tenant,
      task,
      status: "running",
      events: [],
      nextSeq: 0,
      refcount: 0,
      lastActivity: this.now(),
      controller: new AbortController(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(tenant: string): Session[] {
    return [...this.sessions.values()].filter((s) => s.tenant === tenant);
  }

  /** Mark recent activity (resets the GC idle clock). No-op for an unknown id. */
  touch(id: string): void {
    const s = this.sessions.get(id);
    if (s) s.lastActivity = this.now();
  }

  /**
   * Append an event under a fresh monotonic seq, push onto the bounded ring
   * (evicting the oldest past the cap), and refresh activity. Returns the seq
   * (0 if the session is unknown).
   */
  append(id: string, event: GatewayEvent): number {
    const s = this.sessions.get(id);
    if (!s) return 0;
    const seq = ++s.nextSeq;
    s.events.push({ seq, event });
    if (s.events.length > this.bufferMax) s.events.shift();
    s.lastActivity = this.now();
    return seq;
  }

  /** Buffered entries with `seq > after`, in order (drives Last-Event-ID replay). */
  eventsAfter(id: string, after: number): SeqEvent[] {
    const s = this.sessions.get(id);
    if (!s) return [];
    return s.events.filter((e) => e.seq > after);
  }

  /** Smallest seq still retained in the ring (0 if none buffered). */
  minSeq(id: string): number {
    const s = this.sessions.get(id);
    if (!s || s.events.length === 0) return 0;
    return s.events[0].seq;
  }

  /** Largest seq assigned so far (0 if none). */
  maxSeq(id: string): number {
    const s = this.sessions.get(id);
    return s ? s.nextSeq : 0;
  }

  incRef(id: string): number {
    const s = this.sessions.get(id);
    if (!s) return 0;
    s.refcount += 1;
    s.lastActivity = this.now();
    return s.refcount;
  }

  decRef(id: string): number {
    const s = this.sessions.get(id);
    if (!s) return 0;
    s.refcount = Math.max(0, s.refcount - 1);
    s.lastActivity = this.now();
    return s.refcount;
  }

  /** Record a terminal status (+ optional result/error) and refresh activity. */
  finish(id: string, status: RunStatus, result?: RunResult, error?: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.status = status;
    if (result) s.result = result;
    if (error) s.error = error;
    s.lastActivity = this.now();
  }

  abort(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.controller.abort();
    if (s.status === "running") s.status = "aborted";
    s.lastActivity = this.now();
    return true;
  }

  /** True if a session may be collected: unattached, terminal, and idle past TTL. */
  isCollectable(id: string, ttlMs: number): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    return s.refcount === 0 && s.status !== "running" && this.now() - s.lastActivity > ttlMs;
  }

  /** Evict every collectable session; returns the ids removed (for logging/metrics). */
  collect(ttlMs: number): string[] {
    const evicted: string[] = [];
    for (const id of this.sessions.keys()) {
      if (this.isCollectable(id, ttlMs)) { this.sessions.delete(id); evicted.push(id); }
    }
    return evicted;
  }
}
