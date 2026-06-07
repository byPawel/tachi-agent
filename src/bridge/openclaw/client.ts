// src/bridge/openclaw/client.ts
/**
 * GatewayClient — OpenClaw's remote handle to a running `tachi-agent-gateway`.
 *
 * Delegates a task over the EXISTING gateway HTTP/SSE API:
 *   POST /runs            → { run_id }              (start)
 *   GET  /runs/:id/events → SSE step/.../final|error (stream)
 *   GET  /runs/:id        → { status, result }       (poll)
 *   DELETE /runs/:id      → { status:"aborted" }      (cancel)
 *
 * Zero deps: native fetch + ReadableStream. `fetchImpl` is injectable for tests
 * (mirrors OllamaDriver). The gateway side needs NO changes for this to work.
 */
import type { AgentEvent } from "../../types.js";
import { SseFrameParser } from "./sse-parse.js";

export interface GatewayClientConfig {
  /** Base URL of the gateway, e.g. "http://127.0.0.1:8787". Trailing slash trimmed. */
  baseUrl: string;
  /** Bearer token (matches GATEWAY_TOKEN, or the token half of a GATEWAY_TOKENS pair). */
  token: string;
  /** Default wall-clock cap for runAndWait (ms). Default 180_000. */
  timeoutMs?: number;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** A started run handle. */
export interface StartedRun {
  runId: string;
  status: "running";
}

/** Current server-side state of a run. */
export interface RunState {
  runId: string;
  status: "running" | "done" | "error" | "aborted";
  /** RunResult.answer once finished; undefined while running. */
  result?: string;
  error?: string;
}

/** The settled outcome of a streamed run. */
export interface RunOutcome {
  /** "final" carries the answer; "error" carries the message. */
  status: "final" | "error";
  /** Final answer text (present when status === "final"). */
  answer?: string;
  /** Error message (present when status === "error"). */
  error?: string;
}

/** Raised when the gateway returns a non-2xx HTTP status. */
export class GatewayHttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "GatewayHttpError";
  }
}

export class GatewayClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: GatewayClientConfig) {
    this.baseUrl = cfg.baseUrl.replace(/\/$/, "");
    this.token = cfg.token;
    this.timeoutMs = cfg.timeoutMs ?? 180_000;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, ...extra };
  }

  /** Start a run. POST /runs → { run_id, status:"running" } (202). */
  async startRun(
    task: string,
    opts: { maxIterations?: number; signal?: AbortSignal } = {},
  ): Promise<StartedRun> {
    const body: { task: string; maxIterations?: number } = { task };
    if (opts.maxIterations !== undefined) body.maxIterations = opts.maxIterations;
    const res = await this.fetchImpl(`${this.baseUrl}/runs`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!res.ok) throw await this.httpError(res);
    const data = (await res.json()) as { run_id: string };
    return { runId: data.run_id, status: "running" };
  }

  /** Poll a run's state. GET /runs/:id → { status, result, error }. */
  async getStatus(runId: string, signal?: AbortSignal): Promise<RunState> {
    const res = await this.fetchImpl(`${this.baseUrl}/runs/${encodeURIComponent(runId)}`, {
      headers: this.headers(),
      signal,
    });
    if (!res.ok) throw await this.httpError(res);
    const d = (await res.json()) as { run_id: string; status: RunState["status"]; result?: string; error?: string };
    return { runId: d.run_id, status: d.status, result: d.result, error: d.error };
  }

  /** Cancel a run. DELETE /runs/:id → { status:"aborted" } (cooperative abort). */
  async cancel(runId: string, signal?: AbortSignal): Promise<RunState> {
    const res = await this.fetchImpl(`${this.baseUrl}/runs/${encodeURIComponent(runId)}`, {
      method: "DELETE",
      headers: this.headers(),
      signal,
    });
    if (!res.ok) throw await this.httpError(res);
    const d = (await res.json()) as { run_id: string; status: RunState["status"] };
    return { runId: d.run_id, status: d.status };
  }

  /**
   * Open GET /runs/:id/events (SSE) and forward each agent event to `onEvent`.
   * Resolves a RunOutcome when a `final`/`error` frame arrives (or the stream
   * ends). Heartbeats are filtered out. `signal` aborts the stream.
   */
  async streamEvents(
    runId: string,
    onEvent: (event: AgentEvent) => void,
    signal?: AbortSignal,
  ): Promise<RunOutcome> {
    const res = await this.fetchImpl(`${this.baseUrl}/runs/${encodeURIComponent(runId)}/events`, {
      headers: this.headers({ Accept: "text/event-stream" }),
      signal,
    });
    if (!res.ok) throw await this.httpError(res);
    if (!res.body) throw new GatewayHttpError(res.status, "gateway returned no SSE body");

    const parser = new SseFrameParser();
    const decoder = new TextDecoder();
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    let outcome: RunOutcome | undefined;

    try {
      for (;;) {
        const { value, done } = await reader.read();
        // On the final read, flush any bytes the TextDecoder held across a chunk
        // boundary (a multi-byte UTF-8 char split in the tail); else decode streaming.
        const chunk = done ? decoder.decode() : decoder.decode(value, { stream: true });
        const frames = parser.push(chunk);
        for (const frame of frames) {
          if (frame.event === "heartbeat") continue;
          const event = JSON.parse(frame.data) as AgentEvent | { type: "error"; message: string };
          if (event.type === "error") {
            outcome = { status: "error", error: (event as { message: string }).message };
          } else {
            onEvent(event as AgentEvent);
            if (event.type === "final") {
              outcome = { status: "final", answer: (event as { answer: string }).answer };
            }
          }
        }
        if (outcome || done) break; // settled, or stream ended (server closes after final/error)
      }
    } finally {
      await reader.cancel().catch(() => {}); // release the socket on early exit/abort
    }

    return outcome ?? { status: "error", error: "stream ended before a final or error event" };
  }

  /**
   * One-shot delegation: start a run, stream it to completion, return the answer.
   * Throws GatewayHttpError if the run errors. `onEvent` (optional) receives live
   * progress; `signal` cancels both the HTTP start and the SSE stream.
   */
  async runAndWait(
    task: string,
    opts: { maxIterations?: number; onEvent?: (event: AgentEvent) => void; signal?: AbortSignal } = {},
  ): Promise<string> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    const onAbort = () => ac.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const { runId } = await this.startRun(task, { maxIterations: opts.maxIterations, signal: ac.signal });
      const outcome = await this.streamEvents(runId, opts.onEvent ?? (() => {}), ac.signal);
      if (outcome.status === "error") {
        throw new GatewayHttpError(502, `run failed: ${outcome.error ?? "unknown error"}`);
      }
      return outcome.answer ?? "";
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Build a GatewayHttpError from a non-ok Response (reads the JSON `error` if present). */
  private async httpError(res: Response): Promise<GatewayHttpError> {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) detail = body.error;
    } catch {
      /* non-JSON body — keep statusText */
    }
    return new GatewayHttpError(res.status, `gateway ${res.status}: ${detail}`);
  }
}
