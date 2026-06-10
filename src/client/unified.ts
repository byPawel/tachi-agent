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
import type { AgentEvent, OrchestratorOptions, RunResult } from "../types.js";
import { buildAgentFromEnv as buildAgentFromEnvDefault, type AgentRuntime } from "../runtime.js";

/**
 * Extended orchestrator options for run-time pass-through.
 * `allowTools` may not yet be in OrchestratorOptions (lands via Task 2 in parallel);
 * if it already is, the intersection collapses safely (same field, same type).
 */
type RunOrchOptions = OrchestratorOptions & {
  /** Override the driver brain for this run only (resolved by the runtime registry). */
  driver?: string;
  /**
   * Per-run tool-surface narrowing: only tools whose exact namespaced name appears
   * in this list are exposed to the driver. Fail-closed: unknown names match nothing.
   * Unset → full tool surface.
   */
  allowTools?: string[];
};

export interface RunOptions extends RunOrchOptions {
  onEvent: (e: AgentEvent) => void;
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
 * `driver` is split out and passed as the second arg to `orchestrator` (multi-heart
 * seam); the rest of the options are forwarded as OrchestratorOptions.
 */
export function localClient(rt: AgentRuntime): UnifiedClient {
  return {
    run: (text, opts) => {
      const { onEvent, signal, maxIterations, timeoutMs, driver, systemPrompt, allowTools, ...rest } = opts;
      return rt.orchestrator(
        { maxIterations, timeoutMs, onEvent, signal, systemPrompt, allowTools, ...rest } as OrchestratorOptions,
        driver,
      ).run(text);
    },
    close: () => rt.close(),
  };
}

/** Injectable deps for tests: fake runtime builder and/or fake fetch. */
export interface UnifiedClientDeps {
  buildAgentFromEnv?: typeof buildAgentFromEnvDefault;
  /** Injectable fetch for tests (daemon-mode path only). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
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
    const { GatewayClient, GatewayHttpError } = await import("../bridge/openclaw/client.js");
    const baseUrl = env.TACHI_DAEMON_URL;
    const token = env.GATEWAY_TOKEN ?? "";
    const fetchImpl = deps.fetchImpl;
    const gw = new GatewayClient({ baseUrl, token, ...(fetchImpl ? { fetchImpl } : {}) });

    return {
      async run(text, opts) {
        const { onEvent, signal, maxIterations, driver, systemPrompt, allowTools } = opts;
        // Build POST /runs body — include the three new run options when provided.
        const body: Record<string, unknown> = { task: text };
        if (maxIterations !== undefined) body.maxIterations = maxIterations;
        if (driver !== undefined) body.driver = driver;
        if (systemPrompt !== undefined) body.systemPrompt = systemPrompt;
        if (allowTools !== undefined) body.allowTools = allowTools;

        // POST /runs directly with extended body, then attach to stream events.
        const fetchFn = fetchImpl ?? fetch;
        const trimmedBase = baseUrl.replace(/\/$/, "");
        const startRes = await fetchFn(`${trimmedBase}/runs`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(body),
          signal,
        });
        if (!startRes.ok) {
          let detail = startRes.statusText;
          try { const d = (await startRes.json()) as { error?: string }; if (d.error) detail = d.error; } catch { /* keep statusText */ }
          throw new GatewayHttpError(startRes.status, `gateway ${startRes.status}: ${detail}`);
        }
        const { run_id: runId } = (await startRes.json()) as { run_id: string };

        // Capture haltedBy from the final event so the returned RunResult mirrors local.
        let haltedBy: RunResult["haltedBy"] = "final-answer";
        const wrapped = (e: AgentEvent): void => {
          if (e.type === "final") haltedBy = e.haltedBy;
          onEvent(e);
        };
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
  const build = deps.buildAgentFromEnv ?? buildAgentFromEnvDefault;
  return localClient(await build());
}
