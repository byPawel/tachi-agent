// src/gateway/server.ts
import http from "node:http";
import type { AgentRuntime } from "../runtime.js";
import type { AgentEvent } from "../types.js";
import type { GatewayEvent } from "./types.js";
import { RunRegistry } from "./registry.js";
import { parseBearer, resolveTenant } from "./auth.js";
import { formatSse, SSE_HEADERS } from "./sse.js";
import type { RunEventLog } from "../daemon/eventlog.js";

const DEFAULT_MAX_BODY_BYTES = 64 * 1024; // request body cap — prevents OOM via giant POST
const DEFAULT_MAX_TASK_CHARS = 32 * 1024; // task string cap

export interface GatewayOptions {
  /** Default + hard ceiling on ReAct iterations per run (a request may lower, never exceed). */
  maxIterations?: number;
  /** Wall-clock cap per run (ms). */
  timeoutMs?: number;
  /** SSE heartbeat interval (ms). Default 15000. */
  heartbeatMs?: number;
  /** Max concurrent running runs per tenant before 429. Default 16. */
  maxConcurrentPerTenant?: number;
  /** Per-run event ring-buffer cap (Last-Event-ID replay depth). Default TACHI_SESSION_BUFFER_MAX ?? 10000. */
  sessionBufferMax?: number;
  /** Injectable clock (ms) for deterministic TTL/GC tests. Defaults to Date.now. */
  now?: () => number;
  /**
   * Optional drain control surface (used by the daemon). When `draining` is true,
   * new `POST /runs` are rejected with 503; the daemon broadcasts a final shutdown
   * frame to every live SSE sink tracked in `sinks` before exiting. The gateway also
   * populates `controls.collect` so the daemon's GC timer can sweep the run registry.
   */
  controls?: GatewayControls;
  /** Token config source. Defaults to process.env. */
  env?: { GATEWAY_TOKENS?: string; GATEWAY_TOKEN?: string };
  /** Request body cap in bytes (413 past this). Default 64 KiB. */
  maxBodyBytes?: number;
  /** Task string cap in characters (400 past this). Default 32 KiB. */
  maxTaskChars?: number;
  /** Optional durable event log — every registry append is also persisted (fire-and-forget). */
  eventLog?: RunEventLog;
}

/** Mutable drain control surface shared between the gateway and its owner (the daemon). */
export interface GatewayControls {
  /** When true, the gateway rejects new runs with 503 (drain mode). */
  draining: boolean;
  /** Every currently-open SSE response (a live event sink). */
  sinks: Set<http.ServerResponse>;
  /**
   * TTL/GC sweep over the gateway's run registry — evicts unattached, finished runs
   * idle past `ttlMs`, returning the evicted ids. The gateway populates this so the
   * daemon's periodic timer can reclaim ring-buffer memory. No-op until the server is
   * created.
   */
  collect?: (ttlMs: number) => string[];
}

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Read a JSON body with a hard byte cap (throws HttpError 413 if exceeded). */
async function readJson(req: http.IncomingMessage, cap: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    total += (c as Buffer).length;
    if (total > cap) throw new HttpError(413, "request body too large");
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
}

export function createGatewayServer(
  runtime: Pick<AgentRuntime, "orchestrator">,
  opts: GatewayOptions = {},
): http.Server {
  const registry = new RunRegistry({ bufferMax: opts.sessionBufferMax, now: opts.now });
  const env = opts.env ?? process.env;
  const heartbeatMs = opts.heartbeatMs ?? 15000;
  const maxConcurrent = opts.maxConcurrentPerTenant ?? 16;
  const iterationCeiling = opts.maxIterations ?? 50;
  const controls = opts.controls;
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const maxTaskChars = opts.maxTaskChars ?? DEFAULT_MAX_TASK_CHARS;
  // Expose the registry's TTL/GC sweep to the daemon (drives periodic memory reclaim).
  if (controls) controls.collect = (ttlMs: number) => registry.collect(ttlMs);

  return http.createServer(async (req, res) => {
    try {
      const tenant = resolveTenant(parseBearer(req.headers.authorization), env);
      if (!tenant) return json(res, 401, { error: "unauthorized" });

      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean); // e.g. ["runs", "<id>", "events"]

      // POST /runs
      if (req.method === "POST" && parts.length === 1 && parts[0] === "runs") {
        if (controls?.draining) { req.resume(); return json(res, 503, { error: "server draining" }); } // reject new work (drain the body so the socket frees)
        if (Number(req.headers["content-length"] ?? 0) > maxBodyBytes) {
          return json(res, 413, { error: "request body too large" });
        }
        const body = await readJson(req, maxBodyBytes);
        const task = typeof body.task === "string" ? body.task.trim() : "";
        if (!task) return json(res, 400, { error: "task required" });
        if (task.length > maxTaskChars) return json(res, 400, { error: "task too long" });
        if (registry.runningCount(tenant.tenant) >= maxConcurrent) {
          return json(res, 429, { error: "too many concurrent runs" });
        }

        // Clamp caller-supplied iterations to [1, ceiling].
        const reqIter =
          typeof body.maxIterations === "number"
            ? Math.min(Math.max(1, Math.floor(body.maxIterations)), iterationCeiling)
            : opts.maxIterations;

        const record = registry.create(tenant.tenant, task);
        const onEvent = (e: AgentEvent) => {
          const seq = registry.append(record.id, e);
          void opts.eventLog?.append(record.id, seq, e).catch(() => { /* logging must never break a run */ });
        };
        runtime
          .orchestrator({ maxIterations: reqIter, timeoutMs: opts.timeoutMs, signal: record.controller.signal, onEvent })
          .run(task)
          .then(
            (result) => registry.finish(record.id, record.controller.signal.aborted ? "aborted" : "done", result),
            (err) => {
              const message = err instanceof Error ? err.message : String(err);
              const seq = registry.append(record.id, { type: "error", message });
              void opts.eventLog?.append(record.id, seq, { type: "error", message }).catch(() => {});
              registry.finish(record.id, "error", undefined, message);
            },
          )
          .catch((fatal) => console.error("[gateway] run finalize error:", fatal));
        return json(res, 202, { run_id: record.id, status: "running" });
      }

      // /runs/:id  and  /runs/:id/events
      if (parts[0] === "runs" && parts[1]) {
        const record = registry.get(parts[1]);
        if (!record || record.tenant !== tenant.tenant) return json(res, 404, { error: "not found" });

        // GET /runs/:id/events  → SSE (with Last-Event-ID resume + gap detection)
        if (req.method === "GET" && parts.length === 3 && parts[2] === "events") {
          // Resume point: `Last-Event-ID` header (SSE-native) or `?lastEventId=` fallback.
          const rawLast = (req.headers["last-event-id"] as string | undefined) ?? url.searchParams.get("lastEventId") ?? "";
          const lastEventId = Number.isFinite(Number(rawLast)) && rawLast !== "" ? Math.max(0, Math.floor(Number(rawLast))) : 0;

          // Gap: the next event the client needs (lastEventId+1) was already evicted
          // from the ring (minSeq>0 means some event is buffered). 409 so the client
          // can fall back to a fresh stream / poll instead of silently skipping events.
          const minSeq = registry.minSeq(record.id);
          if (lastEventId > 0 && minSeq > 0 && minSeq > lastEventId + 1) {
            return json(res, 409, { error: "event history gap", min_available: minSeq });
          }

          res.writeHead(200, SSE_HEADERS);
          registry.incRef(record.id); // a live SSE sink — refcount guards GC + drain
          controls?.sinks.add(res);   // track for drain-time shutdown broadcast

          // Subscribe-then-replay (no await between) so an append during replay can't
          // be dropped or duplicated: live events arriving before we go live are queued,
          // then flushed by seq once, deduped against what replay already wrote.
          let live = false;
          let closed = false;
          let lastWritten = lastEventId;
          const pending: Array<{ event: GatewayEvent; seq: number }> = [];
          const write = (e: GatewayEvent, seq: number): boolean => {
            try {
              res.write(formatSse(e, seq));
              lastWritten = seq;
              if (e.type === "final" || e.type === "error") { cleanup(); res.end(); return false; }
              return true;
            } catch { cleanup(); res.end(); return false; }
          };

          // Heartbeats carry the run's current max seq as the SSE id: so an idle client
          // keeps its resume cursor fresh (reconnect asks for `> seq` correctly).
          const heartbeat = setInterval(() => {
            try {
              const cur = registry.maxSeq(record.id);
              res.write(cur > 0 ? formatSse({ type: "heartbeat" }, cur) : formatSse({ type: "heartbeat" }));
            } catch { cleanup(); res.end(); }
          }, heartbeatMs);
          const cleanup = () => {
            if (closed) return; // idempotent: req close + final can both fire
            closed = true;
            clearInterval(heartbeat);
            unsub();
            registry.decRef(record.id);
            controls?.sinks.delete(res);
          };
          const unsub = registry.subscribe(record.id, (e, seq) => {
            if (!live) { pending.push({ event: e, seq }); return; }
            write(e, seq);
          });
          req.on("close", cleanup);

          // Replay buffered events strictly after the resume point, in seq order.
          for (const { seq, event } of registry.eventsAfter(record.id, lastEventId)) {
            if (!write(event, seq)) return; // settled mid-replay → done
          }
          // Flush anything that arrived during replay (seq beyond what we just wrote), then go live.
          for (const p of pending) if (p.seq > lastWritten) { if (!write(p.event, p.seq)) return; }
          live = true;

          // A run that already finished (and emitted no live tail) gets its buffered
          // replay above; close the stream now since no more events will come.
          if (record.status !== "running") { cleanup(); return void res.end(); }
          return;
        }

        // GET /runs/:id  → state
        if (req.method === "GET" && parts.length === 2) {
          return json(res, 200, { run_id: record.id, status: record.status, result: record.result?.answer, error: record.error });
        }

        // DELETE /runs/:id  → cancel
        if (req.method === "DELETE" && parts.length === 2) {
          registry.abort(record.id);
          return json(res, 202, { run_id: record.id, status: "aborted" });
        }

        // POST /runs/:id/cancel  → wire-cancel (the client maps an aborted signal here)
        if (req.method === "POST" && parts.length === 3 && parts[2] === "cancel") {
          registry.abort(record.id);
          return json(res, 202, { run_id: record.id, status: "aborted" });
        }
      }

      return json(res, 404, { error: "not found" });
    } catch (e) {
      if (res.headersSent) { res.end(); return; }
      if (e instanceof HttpError) return json(res, e.status, { error: e.message });
      return json(res, 500, { error: "internal error" });
    }
  });
}
