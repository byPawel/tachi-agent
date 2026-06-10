/**
 * Orchestrator — the tachi-agent core ("the hub").
 *
 * A depth-1 ReAct loop with a memory wrap:
 *   dokoro.recall  →  [ reason → tool_calls → dispatch → feedback ]*  →  dokoro.log
 *
 * It depends ONLY on the Driver / ToolHost / Memory seams (see types.ts), so the
 * same core powers every front-end (CLI, Slack, OpenClaw, Codex) and any brain
 * (default local Qwen2.5, or a plugged-in cloud Driver). Depth-1: the agent may
 * call tachibot_jury / tachibot_tachi (which fan out / route internally) but never spawns
 * a nested agent — that keeps the loop debuggable and non-recursive.
 */
import type {
  Driver, ToolHost, Memory, ChatMessage, ToolCall, AgentTool,
  RunResult, OrchestratorOptions,
} from "./types.js";
import { needsGroundingSearch } from "./router.js";
import { estimateCost } from "./cost.js";
import { emitContextInspect, isContextInspectEnvEnabled } from "./context-inspect.js";

const BASE_SYSTEM = `You are TachiAgent, a local-first orchestration agent driving a ReAct loop.
Your tools come from two sources:
- dokoro_*  : persistent project memory (recall / log / status / entity graph).
- tachibot_*: a multi-model brain — tachibot_jury runs several
  frontier models in parallel and synthesize a cross-model verdict; tachibot_grok_search
  and tachibot_perplexity_ask ground claims in current sources.
For any judgment, comparison, or non-trivial decision, CALL tachibot_jury or
tachibot_tachi instead of answering from your own weights — that independent
cross-model verdict / smart-router verdict is the entire point of this agent.
If the user explicitly asks for Grok, use the direct Grok tool that matches the
intent: tachibot_grok_reason for opinions/reasoning, tachibot_grok_search for
current facts/search, tachibot_grok_code for coding, tachibot_grok_debug for
debugging, tachibot_grok_architect for architecture, or tachibot_grok_brainstorm
for ideation.
If the user explicitly asks for Gemini, use the direct Gemini tool that matches
the intent: tachibot_gemini_query for general questions, tachibot_gemini_search
for current facts/search, tachibot_gemini_analyze_code for code analysis,
tachibot_gemini_analyze_text for documents/text, tachibot_gemini_summarize for
summaries, tachibot_gemini_judge for judgment, or tachibot_gemini_brainstorm for
ideation.
If the user explicitly asks for Perplexity, use the direct Perplexity tool that
matches the intent: tachibot_perplexity_ask for quick grounded Q&A,
tachibot_perplexity_research for deeper research, tachibot_perplexity_reason for
reasoning, tachibot_perplexity_fact_check for verification, or
tachibot_perplexity_code_search for code/API/library search.
If the user explicitly asks for Qwen, use the direct Qwen tool that matches the
intent: tachibot_qwen_general for general questions, tachibot_qwen_reason for
reasoning, tachibot_qwen_coder for coding, tachibot_qwen_algo for algorithms, or
tachibot_qwen_competitive for competitive-programming style problems.

GROUNDING RULES (critical — do not violate):
- NEVER invent facts about a specific named entity: a website (e.g. any .com), product,
  company, library, repo, or person. If the user names one, you MUST call
  tachibot_grok_search (or tachibot_perplexity_ask) to look it up BEFORE describing it.
- If the search returns little or nothing about that entity, say so plainly:
  "I couldn't find reliable information on X." Do NOT fabricate a plausible-sounding
  description. A confident wrong answer is far worse than admitting uncertainty.
- Only state specifics that came from a tool result or are genuinely common knowledge.

Gather evidence, reason briefly, then reply with NO tool calls and a clear final answer.`;

/** How many consecutive blank turns the loop will nudge through before giving up. */
const MAX_CONSECUTIVE_EMPTY = 2;
const EMPTY_TURN_NUDGE =
  "Your last turn was empty. Either call a tool or give a clear, non-empty final answer.";

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); } catch { return fallback; }
}

function lastAssistantText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && m.content) return m.content;
  }
  return "";
}

function explicitlyRequestsGrok(task: string): boolean {
  return /\b(?:grok|xai|x\.ai)\b/i.test(task);
}

function selectGroundingSearchTool(tools: AgentTool[], task: string): AgentTool | undefined {
  const grokSearch = tools.find((t) => /grok_search$/.test(t.name));
  if (explicitlyRequestsGrok(task)) return grokSearch;
  return grokSearch ?? tools.find((t) => /perplexity_ask$/.test(t.name));
}

export class Orchestrator {
  constructor(
    private readonly driver: Driver,
    private readonly host: ToolHost,
    private readonly memory?: Memory,
    private readonly opts: OrchestratorOptions = {},
  ) {}

  async run(task: string): Promise<RunResult> {
    const maxIterations = this.opts.maxIterations ?? 10;
    const timeoutMs = this.opts.timeoutMs ?? 120_000;
    const maxEmptyTurns = this.opts.maxEmptyTurns ?? MAX_CONSECUTIVE_EMPTY;
    const deadline = Date.now() + timeoutMs;
    const allow = this.opts.allowTools;
    const tools = allow ? this.host.tools().filter((t) => allow.includes(t.name)) : this.host.tools();
    const toolCalls: RunResult["toolCalls"] = [];

    // 1. RECALL — pull relevant prior context from dokoro before reasoning.
    const recalled = this.memory ? await safe(() => this.memory!.recall(task, this.opts.signal), "") : "";

    // 1b. ROUTER (deterministic) — force a grounding SEARCH for entity/URL questions
    // so the model can't describe a named entity from (hallucinated) priors.
    let grounding = "";
    if (this.opts.forceGrounding || needsGroundingSearch(task)) {
      const searchTool = selectGroundingSearchTool(tools, task);
      if (searchTool) {
        const result = await safe(() => this.host.call(searchTool.name, { query: task }, this.opts.signal), "");
        if (result) {
          grounding = `\n\n--- Grounding search results (base ALL facts about named entities/URLs on THIS; if it does not contain the answer, say you couldn't find it — do NOT invent) ---\n${result}`;
          toolCalls.push({ name: searchTool.name, args: { query: task }, result });
          this.opts.onEvent?.({ type: "tool-result", name: searchTool.name, result });
        }
      } else if (explicitlyRequestsGrok(task) && !this.opts.allowTools) {
        // Sentinel only for GLOBAL config gaps (no grok_search exposed at all).
        // When a skill's allowTools narrowed the surface, grounding silently
        // no-ops — injecting "do not substitute" advice would steer the model
        // away from grounding entirely, which is worse than the no-op.
        const result = "[Grok search unavailable: the user explicitly requested Grok/XAI, but no tachibot_grok_search tool is exposed. Do not silently substitute Perplexity; say Grok is unavailable or adjust TACHI_ALLOW/config.]";
        grounding = `\n\n--- Grounding search unavailable ---\n${result}`;
        toolCalls.push({ name: "tachibot_grok_search", args: { query: task }, result });
        this.opts.onEvent?.({ type: "tool-result", name: "tachibot_grok_search", result });
      }
    }

    // Memory-in-loop (opt-in): a refreshable "live memory" system block kept near
    // the top so each iteration sees recall refreshed for the evolving state.
    // Gated so the default path (memoryInLoop unset/false) is byte-identical.
    const memoryInLoop = (this.opts.memoryInLoop ?? false) && !!this.memory;
    const liveMemory: ChatMessage | null = memoryInLoop
      ? { role: "system", content: recalled ? `--- Live memory (refreshed for the current step) ---\n${recalled}` : "" }
      : null;

    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          (this.opts.systemPrompt ? this.opts.systemPrompt + "\n\n" : "") +
          BASE_SYSTEM +
          (recalled && !memoryInLoop ? `\n\n--- Relevant prior context (memory) ---\n${recalled}` : "") +
          grounding,
      },
      ...(liveMemory ? [liveMemory] : []),
      { role: "user", content: task },
    ];

    // Context inspector (opt-in): emit one JSONL event before each driver.chat.
    // Gated once here so the default path (flag unset) takes ZERO new awaits and
    // stays byte-identical — pure observability that never throws into the loop.
    const contextInspect = this.opts.contextInspect ?? isContextInspectEnvEnabled();

    // 2. REASON+ACT — the ReAct loop, with hard HALT guards.
    const emit = this.opts.onEvent ?? (() => {});
    let haltedBy: RunResult["haltedBy"] = "max-iterations";
    let answer = "";
    let iterations = 0;
    let consecutiveEmpty = 0; // bounded nudge-retry guard for blank local-model turns

    while (iterations < maxIterations) {
      if (this.opts.signal?.aborted) { haltedBy = "aborted"; break; }
      if (Date.now() > deadline) { haltedBy = "timeout"; break; }
      iterations++;
      emit({ type: "step", iteration: iterations });

      // Immediately before the model call: snapshot the assembled context (opt-in).
      if (contextInspect) {
        await emitContextInspect({ messages, tools, turn: iterations, enabled: true });
      }

      const res = await this.driver.chat({ messages, tools });
      emit({ type: "assistant", content: res.content, toolCalls: res.toolCalls });

      if (!res.toolCalls.length) {
        // A blank turn (no tool calls AND no content) is a local-model flake, NOT a
        // final answer. Nudge and retry up to MAX_CONSECUTIVE_EMPTY times; once the
        // budget is spent — or this was the last allowed iteration — halt honestly as
        // "empty-response" instead of emitting a misleading "final-answer" placeholder.
        if (!res.content?.trim()) {
          consecutiveEmpty++;
          if (consecutiveEmpty > maxEmptyTurns || iterations >= maxIterations) {
            haltedBy = "empty-response";
            break;
          }
          messages.push({ role: "assistant", content: res.content });
          messages.push({ role: "user", content: EMPTY_TURN_NUDGE });
          continue;
        }
        answer = res.content;
        haltedBy = "final-answer";
        messages.push({ role: "assistant", content: res.content });
        break;
      }

      consecutiveEmpty = 0; // a productive tool-call turn clears the empty streak
      messages.push({ role: "assistant", content: res.content, toolCalls: res.toolCalls });
      for (const tc of res.toolCalls) {
        const result = await this.dispatch(tc, tools, this.opts.signal);
        emit({ type: "tool-result", name: tc.name, result });
        toolCalls.push({ name: tc.name, args: tc.arguments, result });
        messages.push({ role: "tool", content: result, toolCallId: tc.name });
      }

      // Memory-in-loop (opt-in): per-step note + recall refresh for the next turn.
      if (memoryInLoop && this.memory) {
        if (this.memory.note) {
          const summary = (res.content?.trim() || res.toolCalls.map((c) => c.name).join(", ")).slice(0, 800);
          await safe(() => this.memory!.note!({ task, note: `step ${iterations}: ${summary}` }, this.opts.signal), undefined);
        }
        const focus = lastAssistantText(messages) || task;
        const refreshed = await safe(() => this.memory!.recall(focus, this.opts.signal), "");
        if (liveMemory) liveMemory.content = refreshed ? `--- Live memory (refreshed for the current step) ---\n${refreshed}` : "";
      }
    }

    if (!answer) {
      answer = lastAssistantText(messages) || `[halted: ${haltedBy}, no final answer produced]`;
    }

    // 3. LOG — persist the outcome back to dokoro so the next run remembers.
    if (this.memory) await safe(() => this.memory!.log({ task, result: answer }, this.opts.signal), undefined);

    const costUsd = estimateCost(toolCalls);
    emit({ type: "cost", usd: costUsd, calls: toolCalls.length });
    emit({ type: "final", answer, haltedBy });
    return { answer, iterations, toolCalls, haltedBy, costUsd };
  }

  /** Dispatch one tool call through the ToolHost; never throws (errors are fed back to the model). */
  private async dispatch(tc: ToolCall, tools: AgentTool[], signal?: AbortSignal): Promise<string> {
    if (!tools.some((t) => t.name === tc.name)) {
      return `[error: unknown tool "${tc.name}". Available: ${tools.map((t) => t.name).join(", ")}]`;
    }
    try {
      return await this.host.call(tc.name, tc.arguments, signal);
    } catch (e) {
      return `[tool "${tc.name}" failed: ${e instanceof Error ? e.message : String(e)}]`;
    }
  }
}
