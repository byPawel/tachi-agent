/**
 * HermesDriver — a Nous Research "Hermes" brain over an OpenAI-compatible
 * /chat/completions endpoint (vLLM / TGI / llama.cpp fronting a Hermes model).
 *
 * Thin preset over the generic OpenAICompatDriver (see openai-compat.ts) — only
 * the env-var mapping and defaults live here; all protocol code is shared with
 * the openai/openrouter presets.
 *
 * Config via env: HERMES_BASE_URL, HERMES_MODEL, optional HERMES_API_KEY.
 * The base URL is expected to already include any `/v1` segment (OpenAI convention).
 */
import type { AgentTool } from "../types.js";
import { OpenAICompatDriver, OpenAICompatUnavailableError, toOpenAICompatTool } from "./openai-compat.js";

export class HermesUnavailableError extends OpenAICompatUnavailableError {
  constructor(detail: string) { super(detail); this.name = "HermesUnavailableError"; }
}

export interface HermesDriverConfig {
  baseUrl?: string;    // default http://127.0.0.1:8080/v1 (include any /v1 segment)
  model?: string;      // default Hermes-3-Llama-3.1-8B
  apiKey?: string;     // optional; sent as `Authorization: Bearer <key>` when set
  temperature?: number;
  timeoutMs?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

/** MCP tool → OpenAI-compatible function-calling tool schema (kept for back-compat). */
export function toHermesTool(t: AgentTool) {
  return toOpenAICompatTool(t);
}

export class HermesDriver extends OpenAICompatDriver {
  constructor(cfg: HermesDriverConfig = {}) {
    super({
      namePrefix: "hermes",
      label: "Hermes",
      baseUrl: cfg.baseUrl ?? process.env.HERMES_BASE_URL ?? "http://127.0.0.1:8080/v1",
      model: cfg.model ?? process.env.HERMES_MODEL ?? "Hermes-3-Llama-3.1-8B",
      apiKey: cfg.apiKey ?? process.env.HERMES_API_KEY ?? undefined,
      temperature: cfg.temperature,
      timeoutMs: cfg.timeoutMs,
      envHint: "Is it running? (set HERMES_BASE_URL / HERMES_MODEL, and HERMES_API_KEY if the server needs one)",
      makeError: (d) => new HermesUnavailableError(d),
      fetchImpl: cfg.fetchImpl,
    });
  }
}
