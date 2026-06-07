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
import type { AgentEvent, RunResult } from "../../types.js";
import type { UnifiedClient } from "../../client/unified.js";
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

  /** Wire-cancel: POST /runs/:id/cancel (the attach-time abort path). Best-effort. */
  private async wireCancel(runId: string): Promise<void> {
    try {
      await this.fetchImpl(`${this.baseUrl}/runs/${encodeURIComponent(runId)}/cancel`, {
        method: "POST",
        headers: this.headers(),
      });
    } catch {
      /* best-effort: the stream is already tearing down */
    }
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
   * Attach to a (possibly already-running) run and stream it to completion, resuming
   * from `lastEventId` via the SSE-native `Last-Event-ID` header. The server replays
   * buffered events with `seq > lastEventId` then streams live; we verify the ids stay
   * contiguous (no gap/dup) across the replay→live boundary, throwing on a continuity
   * break. `signal.abort()` issues a wire-cancel (`POST /runs/:id/cancel`).
   *
   * Heartbeats (which carry the run's current max seq, not the next event seq) are
   * filtered out and do NOT participate in the continuity check.
   */
  async attach(
    runId: string,
    opts: { lastEventId?: number; onEvent: (event: AgentEvent) => void; signal?: AbortSignal },
  ): Promise<RunOutcome> {
    const lastEventId = opts.lastEventId ?? 0;
    // Map an aborted signal to a wire-cancel (POST /runs/:id/cancel) so the DAEMON
    // stops the run, not just our local stream. Fire-and-forget; never aborted itself.
    const onAbort = () => { void this.wireCancel(runId); };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const extra: Record<string, string> = { Accept: "text/event-stream" };
    if (lastEventId > 0) extra["Last-Event-ID"] = String(lastEventId);

    const res = await this.fetchImpl(`${this.baseUrl}/runs/${encodeURIComponent(runId)}/events`, {
      headers: this.headers(extra),
      signal: opts.signal,
    });
    if (!res.ok) {
      opts.signal?.removeEventListener("abort", onAbort);
      throw await this.httpError(res); // e.g. 409 event history gap
    }
    if (!res.body) {
      opts.signal?.removeEventListener("abort", onAbort);
      throw new GatewayHttpError(res.status, "gateway returned no SSE body");
    }

    const parser = new SseFrameParser();
    const decoder = new TextDecoder();
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    let outcome: RunOutcome | undefined;
    let expectedNext = lastEventId + 1; // the next data-event seq we expect to see
    // A fresh attach (lastEventId 0) hasn't seen anything yet, so it adopts whatever the
    // server's oldest available frame is — early events may have been evicted from the ring.
    let anchorToFirst = lastEventId === 0;

    try {
      for (;;) {
        const { value, done } = await reader.read();
        const chunk = done ? decoder.decode() : decoder.decode(value, { stream: true });
        for (const frame of parser.push(chunk)) {
          if (frame.event === "heartbeat") continue; // heartbeats carry maxSeq, not next-seq
          const event = JSON.parse(frame.data) as
            | AgentEvent
            | { type: "error"; message: string }
            | { type: "shutdown"; reason: string };
          if (event.type === "error") {
            outcome = { status: "error", error: (event as { message: string }).message };
            continue;
          }
          if (event.type === "shutdown") {
            // The daemon is draining — treat as a terminal error rather than leaking a
            // non-AgentEvent through onEvent (it is NOT a heartbeat/error/agent event).
            outcome = { status: "error", error: "server shutting down" };
            continue;
          }
          // Continuity check on data events: ids must be contiguous (no skip), and we
          // dedupe a replayed event we've already counted (id < expectedNext).
          if (frame.id !== undefined) {
            if (anchorToFirst) {
              // First frame of a fresh attach: accept the server's oldest-available id as
              // the start of the sequence (don't false-positive a "gap" when seq 1 was evicted).
              expectedNext = frame.id;
              anchorToFirst = false;
            }
            if (frame.id < expectedNext) continue;            // already-seen duplicate → skip
            if (frame.id > expectedNext) {                     // a hole → events were lost
              throw new GatewayHttpError(
                502,
                `event continuity gap: expected id ${expectedNext}, got ${frame.id}`,
              );
            }
            expectedNext = frame.id + 1;
          }
          opts.onEvent(event as AgentEvent);
          if (event.type === "final") {
            outcome = { status: "final", answer: (event as { answer: string }).answer };
          }
        }
        if (outcome || done) break;
      }
    } finally {
      await reader.cancel().catch(() => {});
      opts.signal?.removeEventListener("abort", onAbort);
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

/**
 * Remote `UnifiedClient` adapter: a thin handle to a running tachi-agent daemon.
 *
 * `run()` = `startRun` then `attach(runId, { lastEventId: 0 })` — it streams the run
 * to completion over the gateway SSE API, forwarding every `AgentEvent` and returning
 * a `RunResult` shaped identically to the local path. Resuming through `attach` means a
 * dropped SSE connection can be reconnected with `Last-Event-ID`. `close()` is a no-op
 * (the daemon owns the runtime lifecycle). `fetchImpl` is injectable for tests.
 */
export function remoteClient(baseUrl: string, token: string, fetchImpl?: typeof fetch): UnifiedClient {
  const gw = new GatewayClient({ baseUrl, token, fetchImpl });
  return {
    async run(text, { onEvent, signal, maxIterations }) {
      // Capture the final event's haltedBy so the remote RunResult mirrors the local one.
      let haltedBy: RunResult["haltedBy"] = "final-answer";
      const wrapped = (e: AgentEvent): void => {
        if (e.type === "final") haltedBy = e.haltedBy;
        onEvent(e);
      };
      const { runId } = await gw.startRun(text, { maxIterations, signal });
      const outcome = await gw.attach(runId, { lastEventId: 0, onEvent: wrapped, signal });
      if (outcome.status === "error") {
        throw new GatewayHttpError(502, `run failed: ${outcome.error ?? "unknown error"}`);
      }
      return {
        answer: outcome.answer ?? "",
        iterations: 0,
        toolCalls: [],
        haltedBy,
        costUsd: 0,
      };
    },
    close: async () => {},
  };
}
