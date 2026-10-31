/**
 * tachi-watch — the reviewer's brain. A spec string picks it:
 *
 *   codex[:model]   → `codex exec` (the default — a different model family from Claude)
 *   claude[:model]  → `claude -p` (default model haiku — fastest)
 *   gemini[:model]  → `gemini -p`
 *   grok[:model]    → `grok`
 *   driver[:name]   → tachi-agent's own driver (TACHI_DRIVER / ollama / openrouter…)
 *
 * The CLIs run through the coding-agent runner in REVIEW mode (read-only,
 * one turn) — the watcher never edits anything.
 */
import { runCodingAgent, type CodingAgentName } from "../coding-agents/runner.js";
import { getDriver } from "../registry.js";
import "../drivers/register.js";

export interface Brain {
  /** Display name, e.g. "claude:haiku". */
  name: string;
  ask(system: string, user: string, signal?: AbortSignal): Promise<string>;
}

const CLI_AGENTS = new Set<CodingAgentName>(["claude", "codex", "gemini", "grok"]);
const DEFAULT_MODELS: Partial<Record<CodingAgentName, string>> = { claude: "haiku" };

export function parseBrainSpec(spec: string): { kind: "cli"; agent: CodingAgentName; model?: string } | { kind: "driver"; name?: string } {
  const [head, ...rest] = spec.trim().split(":");
  const tail = rest.join(":").trim() || undefined; // models may contain ':' (ollama tags)
  if (head === "driver") return { kind: "driver", name: tail };
  if (CLI_AGENTS.has(head as CodingAgentName)) {
    const agent = head as CodingAgentName;
    return { kind: "cli", agent, model: tail ?? DEFAULT_MODELS[agent] };
  }
  throw new Error(`unknown brain "${spec}" — use claude|codex|gemini|grok|driver[:model]`);
}

export function makeBrain(spec: string, cwd: string): Brain {
  const parsed = parseBrainSpec(spec);

  if (parsed.kind === "driver") {
    const driver = getDriver(parsed.name || process.env.TACHI_DRIVER?.trim() || "ollama");
    return {
      name: `driver:${driver.name}`,
      async ask(system, user) {
        const res = await driver.chat({ messages: [{ role: "system", content: system }, { role: "user", content: user }], tools: [] });
        return res.content;
      },
    };
  }

  const { agent, model } = parsed;
  return {
    name: model ? `${agent}:${model}` : agent,
    async ask(system, user, signal) {
      const res = await runCodingAgent({
        agent,
        model,
        task: `${system}\n\n---\n\n${user}`,
        cwd,
        mode: "review",
        maxTurns: 1,
        timeoutMs: 180_000,
        visibility: "final",
        signal,
      });
      if (res.exitCode !== 0 && !res.answer.trim()) {
        throw new Error(`${agent} exited ${res.exitCode}${res.timedOut ? " (timeout)" : ""}: ${res.stderr.trim().slice(0, 200)}`);
      }
      return res.answer;
    },
  };
}
