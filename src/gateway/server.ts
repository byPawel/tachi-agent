// src/gateway/server.ts
import http from "node:http";
import type { AgentRuntime } from "../runtime.js";
import type { AgentEvent } from "../types.js";
import { RunRegistry } from "./registry.js";
import { parseBearer, resolveTenant } from "./auth.js";
import { formatSse, SSE_HEADERS } from "./sse.js";

const MAX_BODY_BYTES = 64 * 1024; // request body cap — prevents OOM via giant POST
const MAX_TASK_CHARS = 32 * 1024; // task string cap

export interface GatewayOptions {
  /** Default + hard ceiling on ReAct iterations per run (a request may lower, never exceed). */
  maxIterations?: number;
  /** Wall-clock cap per run (ms). */
  timeoutMs?: number;
  /** SSE heartbeat interval (ms). Default 15000. */
  heartbeatMs?: number;
  /** Max concurrent running runs per tenant before 429. Default 16. */
  maxConcurrentPerTenant?: number;
  /** Token config source. Defaults to process.env. */
  env?: { GATEWAY_TOKENS?: string; GATEWAY_TOKEN?: string };
}

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Read a JSON body with a hard byte cap (throws HttpError 413 if exceeded). */
async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    total += (c as Buffer).length;
    if (total > MAX_BODY_BYTES) throw new HttpError(413, "request body too large");
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
  const registry = new RunRegistry();
  const env = opts.env ?? process.env;
  const heartbeatMs = opts.heartbeatMs ?? 15000;
  const maxConcurrent = opts.maxConcurrentPerTenant ?? 16;
  const iterationCeiling = opts.maxIterations ?? 50;

  return http.createServer(async (req, res) => {
    try {
      const tenant = resolveTenant(parseBearer(req.headers.authorization), env);
      if (!tenant) return json(res, 401, { error: "unauthorized" });

      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean); // e.g. ["runs", "<id>", "events"]

      // POST /runs
      if (req.method === "POST" && parts.length === 1 && parts[0] === "runs") {
        if (Number(req.headers["content-length"] ?? 0) > MAX_BODY_BYTES) {
          return json(res, 413, { error: "request body too large" });
        }
        const body = await readJson(req);
        const task = typeof body.task === "string" ? body.task.trim() : "";
        if (!task) return json(res, 400, { error: "task required" });
        if (task.length > MAX_TASK_CHARS) return json(res, 400, { error: "task too long" });
        if (registry.runningCount(tenant.tenant) >= maxConcurrent) {
          return json(res, 429, { error: "too many concurrent runs" });
        }

        // Clamp caller-supplied iterations to [1, ceiling].
        const reqIter =
          typeof body.maxIterations === "number"
            ? Math.min(Math.max(1, Math.floor(body.maxIterations)), iterationCeiling)
            : opts.maxIterations;

        const record = registry.create(tenant.tenant, task);
        const onEvent = (e: AgentEvent) => registry.append(record.id, e);
        runtime
          .orchestrator({ maxIterations: reqIter, timeoutMs: opts.timeoutMs, signal: record.controller.signal, onEvent })
          .run(task)
          .then(
            (result) => registry.finish(record.id, record.controller.signal.aborted ? "aborted" : "done", result),
            (err) => {
              const message = err instanceof Error ? err.message : String(err);
              registry.append(record.id, { type: "error", message });
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

        // GET /runs/:id/events  → SSE
        if (req.method === "GET" && parts.length === 3 && parts[2] === "events") {
          res.writeHead(200, SSE_HEADERS);
          record.events.forEach((e, i) => res.write(formatSse(e, i))); // replay buffered
          if (record.status !== "running") return void res.end();

          const heartbeat = setInterval(() => res.write(formatSse({ type: "heartbeat" })), heartbeatMs);
          const cleanup = () => { clearInterval(heartbeat); unsub(); };
          const unsub = registry.subscribe(record.id, (e, i) => {
            try {
              res.write(formatSse(e, i));
              if (e.type === "final" || e.type === "error") { cleanup(); res.end(); }
            } catch { cleanup(); res.end(); } // socket gone → always release the interval/sub
          });
          req.on("close", cleanup);
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
      }

      return json(res, 404, { error: "not found" });
    } catch (e) {
      if (res.headersSent) { res.end(); return; }
      if (e instanceof HttpError) return json(res, e.status, { error: e.message });
      return json(res, 500, { error: "internal error" });
    }
  });
}
