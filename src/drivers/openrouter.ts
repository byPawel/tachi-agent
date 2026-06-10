/**
 * OpenRouter preset — any OpenRouter-routed model as a thin env-mapped factory
 * over the generic OpenAICompatDriver. No protocol code here, only config.
 *
 * Env: OPENROUTER_API_KEY (required), OPENROUTER_MODEL (default openrouter/auto),
 * OPENROUTER_BASE_URL (default https://openrouter.ai/api/v1).
 */
import { OpenAICompatDriver } from "./openai-compat.js";

export interface OpenRouterDriverConfig {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  temperature?: number;
  timeoutMs?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

/** Read an env var, treating empty/blank as unset. */
function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

export function createOpenRouterDriver(cfg: OpenRouterDriverConfig = {}): OpenAICompatDriver {
  const apiKey = cfg.apiKey ?? env("OPENROUTER_API_KEY");
  if (!apiKey) {
    throw new Error(
      'Driver "openrouter" requires OPENROUTER_API_KEY — set it to your OpenRouter API key ' +
      "(https://openrouter.ai/keys), or pick another brain via TACHI_DRIVER.",
    );
  }
  return new OpenAICompatDriver({
    namePrefix: "openrouter",
    label: "OpenRouter",
    baseUrl: cfg.baseUrl ?? env("OPENROUTER_BASE_URL") ?? "https://openrouter.ai/api/v1",
    model: cfg.model ?? env("OPENROUTER_MODEL") ?? "openrouter/auto",
    apiKey,
    temperature: cfg.temperature,
    timeoutMs: cfg.timeoutMs,
    envHint: "(check OPENROUTER_API_KEY, and OPENROUTER_BASE_URL / OPENROUTER_MODEL if overridden)",
    fetchImpl: cfg.fetchImpl,
  });
}
