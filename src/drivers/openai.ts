/**
 * OpenAI preset — the real OpenAI API ("GPT" brain) as a thin env-mapped factory
 * over the generic OpenAICompatDriver. No protocol code here, only config.
 *
 * Env: OPENAI_API_KEY (required), OPENAI_MODEL (default gpt-4o-mini),
 * OPENAI_BASE_URL (default https://api.openai.com/v1 — include the /v1 segment).
 */
import { OpenAICompatDriver } from "./openai-compat.js";

export interface OpenAIDriverConfig {
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

export function createOpenAIDriver(cfg: OpenAIDriverConfig = {}): OpenAICompatDriver {
  const apiKey = cfg.apiKey ?? env("OPENAI_API_KEY");
  if (!apiKey) {
    throw new Error(
      'Driver "openai" requires OPENAI_API_KEY — set it to your OpenAI API key ' +
      "(https://platform.openai.com/api-keys), or pick another brain via TACHI_DRIVER.",
    );
  }
  return new OpenAICompatDriver({
    namePrefix: "openai",
    label: "OpenAI",
    baseUrl: cfg.baseUrl ?? env("OPENAI_BASE_URL") ?? "https://api.openai.com/v1",
    model: cfg.model ?? env("OPENAI_MODEL") ?? "gpt-4o-mini",
    apiKey,
    temperature: cfg.temperature,
    timeoutMs: cfg.timeoutMs,
    envHint: "(check OPENAI_API_KEY, and OPENAI_BASE_URL / OPENAI_MODEL if overridden)",
    fetchImpl: cfg.fetchImpl,
  });
}
