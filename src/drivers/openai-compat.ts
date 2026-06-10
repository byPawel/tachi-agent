/**
 * OpenAICompatDriver — the generic OpenAI-compatible /chat/completions brain.
 *
 * One client for EVERY OpenAI-shaped endpoint: a self-hosted Hermes (vLLM / TGI /
 * llama.cpp), the real OpenAI API, OpenRouter, or anything else speaking the same
 * dialect. Presets (hermes.ts, the openai/openrouter factories in register.ts)
 * only differ in config — base URL, model, API key, env-var mapping — never in
 * protocol code.
 *
 * Mirrors OllamaDriver: passes `tools` (OpenAI function shape) and parses
 * `choices[0].message.tool_calls`. Throws a typed OpenAICompatUnavailableError
 * (or a preset subclass via `makeError`) on any failure so front-ends can show a
 * clean, actionable hint naming the endpoint.
 */
import type { Driver, AgentTool, ChatMessage, DriverResult, ToolCall } from "../types.js";

export class OpenAICompatUnavailableError extends Error {
  constructor(detail: string) { super(detail); this.name = "OpenAICompatUnavailableError"; }
}

export interface OpenAICompatDriverConfig {
  /** Driver name prefix — the driver reports itself as `${namePrefix}:${model}`. */
  namePrefix: string;
  /** Human label for error messages (default: namePrefix). */
  label?: string;
  /** Endpoint base URL, INCLUDING any `/v1` segment (OpenAI convention). */
  baseUrl: string;
  model: string;
  /** Optional; sent as `Authorization: Bearer <key>` when set. */
  apiKey?: string;
  temperature?: number;   // default 0.4
  timeoutMs?: number;     // default 120_000
  /** Appended to transport-failure messages, e.g. "(set OPENAI_BASE_URL / OPENAI_API_KEY)". */
  envHint?: string;
  /** Preset error factory — MUST return an OpenAICompatUnavailableError (subclass) so rethrow detection works. */
  makeError?: (detail: string) => OpenAICompatUnavailableError;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

interface RawToolCall { function: { name: string; arguments: Record<string, unknown> | string }; }

/** MCP tool → OpenAI-compatible function-calling tool schema. */
export function toOpenAICompatTool(t: AgentTool) {
  return { type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } };
}

function parseArgs(a: Record<string, unknown> | string): Record<string, unknown> {
  if (typeof a !== "string") return a ?? {};
  try { return JSON.parse(a); } catch { return {}; }
}

export class OpenAICompatDriver implements Driver {
  readonly name: string;
  private readonly label: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly temperature: number;
  private readonly timeoutMs: number;
  private readonly envHint: string | undefined;
  private readonly makeError: (detail: string) => OpenAICompatUnavailableError;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: OpenAICompatDriverConfig) {
    this.label = cfg.label ?? cfg.namePrefix;
    this.baseUrl = cfg.baseUrl.replace(/\/$/, "");
    this.model = cfg.model;
    this.apiKey = cfg.apiKey;
    this.temperature = cfg.temperature ?? 0.4;
    this.timeoutMs = cfg.timeoutMs ?? 120_000;
    this.envHint = cfg.envHint;
    this.makeError = cfg.makeError ?? ((d) => new OpenAICompatUnavailableError(d));
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.name = `${cfg.namePrefix}:${this.model}`;
  }

  async chat(input: { messages: ChatMessage[]; tools: AgentTool[] }): Promise<DriverResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
      const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.model,
          messages: input.messages.map((m) => ({ role: m.role, content: m.content })),
          tools: input.tools.length ? input.tools.map(toOpenAICompatTool) : undefined,
          stream: false,
          temperature: this.temperature,
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw this.makeError(`${this.label} ${res.status} ${res.statusText} at ${this.baseUrl}`);
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string | null; tool_calls?: RawToolCall[] } }>;
      };
      const message = data.choices?.[0]?.message;
      const content = message?.content ?? "";
      const toolCalls: ToolCall[] = (message?.tool_calls ?? []).map((c) => ({
        name: c.function.name,
        arguments: parseArgs(c.function.arguments),
      }));
      return { content, toolCalls };
    } catch (e) {
      if (e instanceof OpenAICompatUnavailableError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      const hint = this.envHint ? ` ${this.envHint}` : "";
      throw this.makeError(`${this.label} call failed at ${this.baseUrl}: ${msg}.${hint}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
