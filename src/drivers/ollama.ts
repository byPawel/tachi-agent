/**
 * OllamaDriver — the default local brain (Qwen2.5 via Ollama).
 *
 * Uses Ollama's NATIVE /api/chat (num_ctx honored; the OpenAI-compat /v1 path
 * silently drops it). Supports function-calling: passes `tools` and parses
 * `message.tool_calls`. Throws a typed OllamaUnavailableError on any failure so
 * front-ends can show a clean "start Ollama" hint.
 */
import type { Driver, AgentTool, ChatMessage, DriverResult, ToolCall } from "../types.js";

export class OllamaUnavailableError extends Error {
  constructor(detail: string) { super(detail); this.name = "OllamaUnavailableError"; }
}

export interface OllamaDriverConfig {
  baseUrl?: string;   // default http://127.0.0.1:11434
  model?: string;     // default qwen2.5
  numCtx?: number;    // default 8192 (native /api/chat honors this)
  temperature?: number;
  timeoutMs?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

interface OllamaRawToolCall { function: { name: string; arguments: Record<string, unknown> | string }; }

/** MCP tool → Ollama function-calling tool schema. */
export function toOllamaTool(t: AgentTool) {
  return { type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } };
}

function parseArgs(a: Record<string, unknown> | string): Record<string, unknown> {
  if (typeof a !== "string") return a ?? {};
  try { return JSON.parse(a); } catch { return {}; }
}

export class OllamaDriver implements Driver {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly numCtx: number;
  private readonly temperature: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: OllamaDriverConfig = {}) {
    this.baseUrl = (cfg.baseUrl ?? process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").replace(/\/$/, "");
    this.model = cfg.model ?? process.env.OLLAMA_MODEL ?? "qwen2.5";
    this.numCtx = cfg.numCtx ?? (Number(process.env.OLLAMA_NUM_CTX) || 8192);
    this.temperature = cfg.temperature ?? 0.4;
    this.timeoutMs = cfg.timeoutMs ?? 120_000;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.name = `ollama:${this.model}`;
  }

  async chat(input: { messages: ChatMessage[]; tools: AgentTool[] }): Promise<DriverResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model.replace(/:latest$/, ""),
          messages: input.messages.map((m) => ({ role: m.role, content: m.content })),
          tools: input.tools.length ? input.tools.map(toOllamaTool) : undefined,
          stream: false,
          options: { num_ctx: this.numCtx, temperature: this.temperature },
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new OllamaUnavailableError(`Ollama ${res.status} ${res.statusText} at ${this.baseUrl}`);
      const data = (await res.json()) as { message?: { content?: string; tool_calls?: OllamaRawToolCall[] } };
      const content = data.message?.content ?? "";
      const toolCalls: ToolCall[] = (data.message?.tool_calls ?? []).map((c) => ({
        name: c.function.name,
        arguments: parseArgs(c.function.arguments),
      }));
      return { content, toolCalls };
    } catch (e) {
      if (e instanceof OllamaUnavailableError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      throw new OllamaUnavailableError(`Ollama call failed at ${this.baseUrl}: ${msg}. Is it running? (\`ollama serve\` + \`ollama pull ${this.model}\`)`);
    } finally {
      clearTimeout(timer);
    }
  }
}
