/**
 * HermesDriver — a Nous Research "Hermes" brain over an OpenAI-compatible
 * /chat/completions endpoint (vLLM / TGI / llama.cpp fronting a Hermes model).
 *
 * Mirrors OllamaDriver: passes `tools` (OpenAI function shape) and parses
 * `choices[0].message.tool_calls`. Throws a typed HermesUnavailableError on any
 * failure so front-ends can show a clean "start/point-at Hermes" hint.
 *
 * Config via env: HERMES_BASE_URL, HERMES_MODEL, optional HERMES_API_KEY.
 * The base URL is expected to already include any `/v1` segment (OpenAI convention).
 */
import type { Driver, AgentTool, ChatMessage, DriverResult, ToolCall } from "../types.js";

export class HermesUnavailableError extends Error {
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

interface HermesRawToolCall { function: { name: string; arguments: Record<string, unknown> | string }; }

/** MCP tool → OpenAI-compatible function-calling tool schema. */
export function toHermesTool(t: AgentTool) {
  return { type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } };
}

function parseArgs(a: Record<string, unknown> | string): Record<string, unknown> {
  if (typeof a !== "string") return a ?? {};
  try { return JSON.parse(a); } catch { return {}; }
}

export class HermesDriver implements Driver {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly temperature: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: HermesDriverConfig = {}) {
    this.baseUrl = (cfg.baseUrl ?? process.env.HERMES_BASE_URL ?? "http://127.0.0.1:8080/v1").replace(/\/$/, "");
    this.model = cfg.model ?? process.env.HERMES_MODEL ?? "Hermes-3-Llama-3.1-8B";
    this.apiKey = cfg.apiKey ?? process.env.HERMES_API_KEY ?? undefined;
    this.temperature = cfg.temperature ?? 0.4;
    this.timeoutMs = cfg.timeoutMs ?? 120_000;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.name = `hermes:${this.model}`;
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
          tools: input.tools.length ? input.tools.map(toHermesTool) : undefined,
          stream: false,
          temperature: this.temperature,
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new HermesUnavailableError(`Hermes ${res.status} ${res.statusText} at ${this.baseUrl}`);
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string | null; tool_calls?: HermesRawToolCall[] } }>;
      };
      const message = data.choices?.[0]?.message;
      const content = message?.content ?? "";
      const toolCalls: ToolCall[] = (message?.tool_calls ?? []).map((c) => ({
        name: c.function.name,
        arguments: parseArgs(c.function.arguments),
      }));
      return { content, toolCalls };
    } catch (e) {
      if (e instanceof HermesUnavailableError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      throw new HermesUnavailableError(`Hermes call failed at ${this.baseUrl}: ${msg}. Is it running? (set HERMES_BASE_URL / HERMES_MODEL, and HERMES_API_KEY if the server needs one)`);
    } finally {
      clearTimeout(timer);
    }
  }
}
