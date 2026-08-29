import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AgentRuntime } from "../runtime.js";
import {
  runCodingAgent,
  resolveCodingCwd,
  writeAuthorized,
  type CodingAgentName,
  type CodingAgentResult,
  type CodingAgentProgress,
  type RunCodingAgentArgs,
} from "./runner.js";
import {
  beginCodingCoordination,
  finishCodingCoordination,
  type CodingCoordinationContext,
} from "./coordination.js";
import { createSemaphore, resolveCodingConcurrency } from "./concurrency.js";

/** Bounded in-flight coding workers — every call spawns a real OS process. */
const codingSlots = createSemaphore(resolveCodingConcurrency());

export interface RunCodingAgentToolArgs extends Omit<RunCodingAgentArgs, "signal" | "onProgress"> {
  /** Exact files from the implementation plan; Dokoro leases them before launch. */
  plannedFiles?: string[];
  /** Persist a directed Dokoro handoff in addition to returning the MCP result. Default true. */
  reportToDokoro?: boolean;
  /** Dokoro handoff recipient. Default `claude-code`. */
  targetAgent?: string;
}

export interface CodingAgentHandlerContext {
  signal?: AbortSignal;
  onProgress?: (update: CodingAgentProgress) => void | Promise<void>;
}

interface TextResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export type CodingAgentRunner = (args: RunCodingAgentArgs) => Promise<CodingAgentResult>;

/** External coding-agent handler with synchronous return + durable Dokoro handoff. */
export async function runCodingAgentHandler(
  runtime: Pick<AgentRuntime, "host" | "memory">,
  args: RunCodingAgentToolArgs,
  runner: CodingAgentRunner = runCodingAgent,
  context: CodingAgentHandlerContext = {},
): Promise<TextResult> {
  // Recursion guard for ALL agents, before any resource is acquired (write
  // gate, semaphore, preflight, dokoro lease): every tachi-spawned worker env
  // carries TACHI_CODING_DEPTH, so this server running inside a worker means
  // a nested spawn — refuse it to stop A→B→A cycles and fan-out amplification.
  if (process.env.TACHI_CODING_DEPTH) {
    return {
      content: [{
        type: "text",
        text: "tachi coding-agent error: recursion guard — this server is already running " +
          "inside a tachi-spawned worker; nested coding agents are refused.",
      }],
      isError: true,
    };
  }
  // Write mode is opt-in: refuse it up front unless explicitly granted, so an
  // untrusted-content-driven write cannot proceed just because the tool allows it.
  if (!writeAuthorized({ mode: args.mode, env: process.env })) {
    return {
      content: [{
        type: "text",
        text: "tachi coding-agent error: write mode is disabled. " +
          "Set TACHI_CODING_ALLOW_WRITE=1 to enable it, or call with mode:\"review\".",
      }],
      isError: true,
    };
  }

  const reportToDokoro = args.reportToDokoro !== false;
  const agentId = `tachi-${args.agent}-${randomUUID()}`;
  const sessionId = `coding-${new Date().toISOString()}-${agentId}`;
  let coordination: CodingCoordinationContext | undefined;
  let claimed = false;
  let leaseWarning = "";

  const releaseSlot = await codingSlots.acquire(context.signal);
  try {
    const cwd = await resolveCodingCwd(args.cwd);
    coordination = {
      agentId,
      sessionId,
      task: args.task,
      cwd,
      ...(args.plannedFiles?.length ? { files: args.plannedFiles } : {}),
    };
    if (reportToDokoro || coordination.files?.length) {
      const coord = await beginCodingCoordination(runtime.host, { ...coordination, timeoutMs: args.timeoutMs });
      claimed = coord.claimed;
      if (coordination.files?.length && !coord.claimed) {
        leaseWarning = " · ⚠ leases unconfirmed (dokoro absent or lease not granted)";
      }
    }

    const result = await runner({ ...args, cwd, signal: context.signal, onProgress: context.onProgress });
    const identity = [result.agent, result.provider, result.model].filter(Boolean).join("/");
    const summary = [
      `${identity} completed a ${result.mode} coding task in ${result.cwd}.`,
      result.isolated ? "Workspace: isolated git worktree." : "Workspace: requested checkout.",
      // `openrouter` is one agent name over several local CLIs; the handoff has
      // to say which one ran, since their sandboxes and traces differ.
      ...(result.harness ? [`Harness: ${result.harness}.`] : []),
      result.answer,
    ].join("\n\n");

    if (reportToDokoro) await runtime.memory?.log({ task: args.task, result: summary });
    if (reportToDokoro || claimed) {
      await finishCodingCoordination(runtime.host, coordination, {
        summary,
        targetAgent: args.targetAgent,
        writeHandoff: reportToDokoro,
      }, claimed);
    }

    const enterHint = result.sessionId ? enterSessionCommand(result.agent, result.sessionId) : undefined;
    const header = [
      `agent: ${identity}`,
      result.harness ? `harness: ${result.harness}` : "",
      `mode: ${result.mode}`,
      `workspace: ${result.isolated ? "isolated worktree" : result.cwd}`,
      result.sessionId ? `session: ${result.sessionId}` : "",
      enterHint ? `enter: ${enterHint}` : "",
      reportToDokoro ? `handoff: Dokoro → ${args.targetAgent ?? "claude-code"}` : "",
    ].filter(Boolean).join(" · ") + leaseWarning;
    const trace = result.trace?.length
      ? [
        "### Agent trace",
        ...result.trace.map((entry) => `- **${entry.kind}:** ${entry.message}`),
        "",
        "### Final answer",
      ].join("\n")
      : "";
    return {
      content: [{
        type: "text",
        text: [`[${header}]`, trace, result.answer].filter(Boolean).join("\n\n"),
      }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (coordination && (reportToDokoro || claimed)) {
      await finishCodingCoordination(runtime.host, coordination, {
        summary: `${args.agent} coding task failed: ${message}`,
        openItems: [message],
        targetAgent: args.targetAgent,
        writeHandoff: reportToDokoro,
      }, claimed);
    }
    return { content: [{ type: "text", text: `tachi coding-agent error: ${message}` }], isError: true };
  } finally {
    releaseSlot();
  }
}

// Workers are headless one-shots that cannot be entered mid-run; these CLIs can
// reopen the finished worker session as an interactive one. Gemini and Hermes
// have no session-resume affordance, so they get no hint.
function enterSessionCommand(agent: CodingAgentName, sessionId: string): string | undefined {
  if (agent === "grok") return `grok -r ${sessionId}`;
  if (agent === "codex") return `codex resume ${sessionId}`;
  if (agent === "claude") return `claude -r ${sessionId}`;
  return undefined;
}

export function registerCodingAgentTool(server: McpServer, runtime: AgentRuntime): void {
  server.registerTool(
    "run_coding_agent",
    {
      title: "Run external coding agent",
      description:
        "Run Codex CLI, Grok CLI, Gemini CLI, headless Claude Code, full Hermes Agent, or an OpenRouter " +
        "model as a bounded coding worker: review mode is the default, write mode is env-gated, nested tachi " +
        "workers are refused (recursion guard), and grok additionally runs with subagents disabled. " +
        "Returns the result directly to the caller and, by default, records a directed Dokoro handoff. " +
        "Use plannedFiles from a Superpowers task to acquire advisory leases before any edits. " +
        "Review mode is read-only for Codex/Grok/Claude and worktree-isolated for Hermes/Gemini; the " +
        "openrouter agent follows whichever local harness drives it (hermes by default — worktree-isolated; " +
        "codex via TACHI_OPENROUTER_HARNESS — read-only, in place) and reports it back as `harness`. " +
        "Write mode must be explicit. " +
        "For full-power Grok inside Claude Code use the grok-build plugin — this tool is the coordinated bounded lane.",
      inputSchema: {
        agent: z.enum(["codex", "grok", "hermes", "openrouter", "gemini", "claude"]),
        task: z.string().min(1).max(200_000),
        cwd: z.string().optional().describe("Workspace under TACHI_CODING_ROOTS (default MCP server cwd)"),
        model: z.string().optional().describe("Per-run model override; required for the openrouter agent"),
        provider: z.string().optional().describe("Hermes provider override (ignored for the openrouter shortcut)"),
        mode: z.enum(["review", "write"]).optional().default("review"),
        isolate: z.boolean().optional().describe("Hermes/OpenRouter: use an isolated worktree (default true; forced in review mode)"),
        maxTurns: z.number().int().positive().max(500).optional(),
        timeoutMs: z.number().int().min(1_000).max(3_600_000).optional(),
        visibility: z.enum(["final", "trace", "live"]).optional().default("trace")
          .describe("final: answer only; trace: include public execution trace; live: trace plus MCP progress notifications"),
        plannedFiles: z.array(z.string()).max(50).optional()
          .describe("Exact plan files to lease through Dokoro before launching the worker"),
        reportToDokoro: z.boolean().optional().default(true),
        targetAgent: z.string().optional().default("claude-code"),
      },
    },
    async (args, extra) => {
      let progress = 0;
      const progressToken = extra._meta?.progressToken;
      const onProgress = progressToken === undefined
        ? undefined
        : async (update: CodingAgentProgress) => {
          progress += 1;
          await extra.sendNotification({
            method: "notifications/progress",
            params: {
              progressToken,
              progress,
              message: `[${update.kind}] ${update.message}`,
            },
          });
        };
      const result = await runCodingAgentHandler(
        runtime,
        args as RunCodingAgentToolArgs,
        runCodingAgent,
        { signal: extra.signal, onProgress },
      );
      return result as typeof result & { [key: string]: unknown };
    },
  );
}
