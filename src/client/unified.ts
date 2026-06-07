// src/client/unified.ts
/**
 * UnifiedClient — one execution surface for BOTH local (in-process AgentRuntime)
 * and remote (a running tachi-agent daemon over the gateway HTTP/SSE API).
 *
 * Front-ends construct a client with `createUnifiedClient(process.env)` and call
 * `run(text, { onEvent })`; the returned `RunResult` and the streamed `AgentEvent`s
 * are IDENTICAL across local/remote, so the front-end's onEvent / throttle / halt
 * loop is unchanged. When `TACHI_DAEMON_URL` is unset, behavior matches today's
 * in-process path exactly.
 */
import type { AgentEvent, RunResult } from "../types.js";
import { buildAgentFromEnv as buildAgentFromEnvDefault, type AgentRuntime } from "../runtime.js";

export interface RunOptions {
  onEvent: (e: AgentEvent) => void;
  onHalted?: () => void;
  signal?: AbortSignal;
  /** Per-run caps. Omitted → the runtime/daemon applies its own defaults. */
  maxIterations?: number;
  timeoutMs?: number;
}

export interface UnifiedClient {
  /** Identical surface for local OR daemon execution. */
  run(text: string, opts: RunOptions): Promise<RunResult>;
  close(): Promise<void>;
}

/**
 * Local adapter: wraps the in-process AgentRuntime. `maxIterations`/`timeoutMs` are
 * forwarded only when the caller provides them, so a front-end that previously relied
 * on the Orchestrator's own defaults keeps the exact same behavior.
 */
export function localClient(rt: AgentRuntime): UnifiedClient {
  return {
    run: (text, { onEvent, signal, maxIterations, timeoutMs }) =>
      rt.orchestrator({ maxIterations, timeoutMs, onEvent, signal }).run(text),
    close: () => rt.close(),
  };
}

/** Seam for tests — inject a fake runtime builder (mirrors OllamaDriver.fetchImpl). */
export interface UnifiedClientDeps {
  buildAgentFromEnv?: typeof buildAgentFromEnvDefault;
}

/**
 * Factory: pick the local or remote adapter from env.
 *  - `TACHI_DAEMON_URL` set  → REMOTE: attach to the daemon over the gateway API.
 *  - unset                   → LOCAL: build the in-process runtime (today's behavior).
 */
export async function createUnifiedClient(
  env: NodeJS.ProcessEnv,
  deps: UnifiedClientDeps = {},
): Promise<UnifiedClient> {
  if (env.TACHI_DAEMON_URL) {
    // Lazy import keeps the gateway-client (and its transport) off the local path.
    const { remoteClient } = await import("../bridge/openclaw/client.js");
    return remoteClient(env.TACHI_DAEMON_URL, env.GATEWAY_TOKEN ?? "");
  }
  const build = deps.buildAgentFromEnv ?? buildAgentFromEnvDefault;
  return localClient(await build());
}
