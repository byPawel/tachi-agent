import { spawn, type ChildProcess } from "node:child_process";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { buildWorkerEnv, type WorkerAgentName } from "./worker-env.js";
import { preflightCodingAgent, type PreflightDeps } from "./preflight.js";
import { parseGeminiJson, reviewGuard } from "./gemini-parse.js";
import { parseClaudeEnvelope } from "./claude-parse.js";
import { createReviewWorktree, type ReviewWorktree } from "./review-worktree.js";
import {
  buildOpenRouterHarnessCommand,
  resolveOpenRouterHarness,
  type OpenRouterHarnessCommand,
  type OpenRouterHarnessName,
  type OpenRouterOutputKind,
} from "./openrouter-harness.js";

export type CodingAgentName = "codex" | "grok" | "hermes" | "openrouter" | "gemini" | "claude";
export type CodingAgentMode = "review" | "write";
export type CodingAgentVisibility = "final" | "trace" | "live";
export type CodingAgentProgressKind =
  | "status"
  | "reasoning"
  | "command"
  | "file_change"
  | "tool"
  | "plan"
  | "error";

export interface CodingAgentProgress {
  kind: CodingAgentProgressKind;
  message: string;
}

export interface RunCodingAgentArgs {
  agent: CodingAgentName;
  task: string;
  cwd?: string;
  model?: string;
  /** Hermes provider override. `openrouter` forces this to `openrouter`. */
  provider?: string;
  /** `review` is non-mutating for Codex/Grok and worktree-isolated for Hermes. */
  mode?: CodingAgentMode;
  /** Hermes/OpenRouter only. Defaults true; review mode always isolates. */
  isolate?: boolean;
  maxTurns?: number;
  timeoutMs?: number;
  /** final = answer only; trace = answer + completed trace; live = trace + MCP progress notifications. */
  visibility?: CodingAgentVisibility;
  /** Internal progress sink supplied by the MCP frontend. */
  onProgress?: (update: CodingAgentProgress) => void | Promise<void>;
  signal?: AbortSignal;
}

export interface CodingAgentCommand {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv; // minimal, per-agent
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
}

export interface CodingAgentResult extends ProcessResult {
  agent: CodingAgentName;
  mode: CodingAgentMode;
  cwd: string;
  model?: string;
  provider?: string;
  isolated: boolean;
  /** Which local CLI drove the `openrouter` agent. Absent for every other agent. */
  harness?: OpenRouterHarnessName;
  answer: string;
  trace?: CodingAgentProgress[];
  sessionId?: string;
}

export type CommandExecutor = (
  spec: CodingAgentCommand,
  options: {
    timeoutMs: number;
    maxOutputChars: number;
    signal?: AbortSignal;
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
  },
) => Promise<ProcessResult>;

export const DEFAULT_CODING_TIMEOUT_MS = 600_000;
export const MAX_CODING_TIMEOUT_MS = 3_600_000;
export const DEFAULT_MAX_OUTPUT_CHARS = 2_000_000;

const REVIEW_TOOLS = "read_file,grep,list_dir,run_terminal_cmd";

function envCommand(name: CodingAgentName): string {
  const key = name === "openrouter" ? "HERMES_CLI" : `${name.toUpperCase()}_CLI`;
  return process.env[key]?.trim() || (name === "openrouter" ? "hermes" : name);
}

export function openRouterCodingModel(explicit?: string): string | undefined {
  return explicit?.trim()
    || process.env.TACHI_OPENROUTER_CODING_MODEL?.trim()
    || process.env.OPENROUTER_MODEL?.trim()
    || undefined;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value!)));
}

/** Write mode is opt-in: review is safe by default, write must be granted. */
export function writeAuthorized(args: { mode?: CodingAgentMode; env?: NodeJS.ProcessEnv }): boolean {
  if ((args.mode ?? "review") !== "write") return true;
  const env = args.env ?? process.env;
  return env.TACHI_CODING_ALLOW_WRITE === "1" || env.TACHI_CODING_ALLOW_WRITE === "true";
}

/**
 * A leading dash would let the task masquerade as a CLI flag (option-value
 * parsing is parser-dependent for grok/hermes; codex gets `--` too).
 */
function assertTaskIsNotAFlag(task: string): void {
  if (/^\s*-/.test(task)) {
    throw new Error('coding agent task must not start with "-" — prefix it, e.g. "Task: …"');
  }
}

/**
 * Resolve the OpenRouter harness AND its argv in one shot, keeping the metadata
 * (`outputKind`, `workspace`) the runner needs to parse stdout and report
 * isolation. `buildCodingAgentCommand` narrows this to `.command`; only the
 * runner sees the rest.
 */
export function buildOpenRouterHarnessSpec(
  args: RunCodingAgentArgs & { cwd: string },
): OpenRouterHarnessCommand {
  assertTaskIsNotAFlag(args.task);
  const orModel = openRouterCodingModel(args.model);
  if (!orModel) {
    throw new Error(
      "openrouter coding agent requires an explicit model, TACHI_OPENROUTER_CODING_MODEL, or OPENROUTER_MODEL",
    );
  }
  // One public agent name, pluggable local harness. The adapter owns the argv
  // for every harness; the leading-dash guard above still applies to all of them.
  return buildOpenRouterHarnessCommand(
    resolveOpenRouterHarness(process.env),
    {
      task: args.task,
      cwd: args.cwd,
      model: orModel,
      mode: args.mode ?? "review",
      isolate: args.isolate !== false,
      maxTurns: clampInt(args.maxTurns, 40, 1, 500),
      timeoutMs: args.timeoutMs ?? DEFAULT_CODING_TIMEOUT_MS,
    },
    process.env,
  );
}

/** Build argv without a shell: tasks/models are values, never executable syntax. */
export function buildCodingAgentCommand(args: RunCodingAgentArgs & { cwd: string }): CodingAgentCommand {
  assertTaskIsNotAFlag(args.task);
  const mode = args.mode ?? "review";
  const maxTurns = clampInt(args.maxTurns, 40, 1, 500);

  if (args.agent === "codex") {
    const argv = [
      "exec",
      "--ephemeral",
      "--json",
      "--color", "never",
      "--sandbox", mode === "write" ? "workspace-write" : "read-only",
      "-C", args.cwd,
    ];
    if (args.model?.trim()) argv.push("-m", args.model.trim());
    argv.push("--", args.task);
    return { command: envCommand("codex"), args: argv, cwd: args.cwd, env: buildWorkerEnv("codex", process.env) };
  }

  if (args.agent === "gemini") {
    const argv = ["-p", args.task, "--output-format", "json"];
    // Headless plan mode can auto-flip to YOLO after plan-exit; review runs
    // are therefore ALSO worktree-isolated and tamper-checked by the caller.
    if (mode === "write") argv.push("--yolo");
    else argv.push("--approval-mode", "plan");
    if (args.model?.trim()) argv.push("-m", args.model.trim());
    return { command: envCommand("gemini"), args: argv, cwd: args.cwd, env: buildWorkerEnv("gemini", process.env) };
  }

  if (args.agent === "claude") {
    const argv = [
      "-p", args.task,
      "--output-format", "json",
      // Never load the user-scope ~/.claude MCP config: it could re-mount
      // tachi-agent-mcp and recurse around the env marker, or fire user hooks
      // in the worker cwd.
      "--strict-mcp-config",
      "--max-turns", String(maxTurns),
      "--permission-mode", mode === "write" ? "acceptEdits" : "plan",
    ];
    if (args.model?.trim()) argv.push("--model", args.model.trim());
    return { command: envCommand("claude"), args: argv, cwd: args.cwd, env: buildWorkerEnv("claude", process.env) };
  }

  if (args.agent === "grok") {
    const argv = [
      "--no-auto-update",
      "-p", args.task,
      "--cwd", args.cwd,
      "--output-format", "json",
      "--sandbox", mode === "write" ? "workspace" : "read-only",
      "--no-subagents",
      "--disallowed-tools", "Agent",
      "--max-turns", String(maxTurns),
    ];
    if (mode === "write") argv.push("--always-approve");
    if (mode === "review") argv.push("--tools", REVIEW_TOOLS);
    if (args.model?.trim()) argv.push("-m", args.model.trim());
    return { command: envCommand("grok"), args: argv, cwd: args.cwd, env: buildWorkerEnv("grok", process.env) };
  }

  if (args.agent === "openrouter") return buildOpenRouterHarnessSpec({ ...args, mode, maxTurns }).command;

  const provider = args.provider?.trim();
  const model = args.model?.trim();
  const isolated = mode === "review" || args.isolate !== false;
  const argv = [
    "chat",
    "--quiet",
    "--oneshot",
    "--in", args.cwd,
    "--toolsets", "file,terminal,skills",
    "--checkpoints",
    "--max-turns", String(maxTurns),
    "--run-budget", String(Math.max(1, Math.floor((args.timeoutMs ?? DEFAULT_CODING_TIMEOUT_MS) / 1000))),
    "--source", "tool",
  ];
  if (mode === "write") argv.push("--yolo");
  if (provider) argv.push("--provider", provider);
  if (model) argv.push("--model", model);
  if (isolated) argv.push("--worktree");
  argv.push("--query", args.task);
  return { command: envCommand(args.agent), args: argv, cwd: args.cwd, env: buildWorkerEnv(args.agent as WorkerAgentName, process.env) };
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

function configuredRoots(): string[] {
  const raw = process.env.TACHI_CODING_ROOTS;
  return (raw ? raw.split(",") : [process.cwd()]).map((p) => p.trim()).filter(Boolean);
}

/** Resolve symlinks and constrain agent cwd to TACHI_CODING_ROOTS (default server cwd). */
export async function resolveCodingCwd(candidate = process.cwd()): Promise<string> {
  const resolved = await realpath(path.resolve(candidate));
  const info = await stat(resolved);
  if (!info.isDirectory()) throw new Error(`coding agent cwd is not a directory: ${resolved}`);
  const roots = await Promise.all(configuredRoots().map(async (root) => realpath(path.resolve(root))));
  if (!roots.some((root) => isInside(root, resolved))) {
    throw new Error(
      `coding agent cwd is outside the allowed roots: ${resolved}. ` +
      "Set TACHI_CODING_ROOTS to a comma-separated allowlist of workspace roots.",
    );
  }
  return resolved;
}

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  if (process.platform !== "win32") {
    try { process.kill(-child.pid, signal); return; } catch { /* fall through */ }
  }
  try { child.kill(signal); } catch { /* already gone */ }
}

/** Bounded, shell-free process runner used by every external coding harness. */
export const executeCommand: CommandExecutor = (spec, options) => new Promise((resolve, reject) => {
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let aborted = false;
  let settled = false;
  let forceTimer: NodeJS.Timeout | undefined;

  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    shell: false,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });

  const finishReject = (error: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeoutTimer);
    if (forceTimer) clearTimeout(forceTimer);
    options.signal?.removeEventListener("abort", onAbort);
    reject(error);
  };

  const terminate = () => {
    killTree(child, "SIGTERM");
    forceTimer = setTimeout(() => killTree(child, "SIGKILL"), 2_000);
    forceTimer.unref?.();
  };

  const append = (stream: "stdout" | "stderr", chunk: Buffer) => {
    if (settled) return;
    const text = chunk.toString("utf8");
    if (stream === "stdout") {
      stdout += text;
      try { options.onStdout?.(text); } catch { /* progress must not fail the worker */ }
    } else {
      stderr += text;
      try { options.onStderr?.(text); } catch { /* progress must not fail the worker */ }
    }
    if (stdout.length + stderr.length > options.maxOutputChars) {
      terminate();
      finishReject(new Error(`coding agent output exceeded ${options.maxOutputChars} characters`));
    }
  };

  child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));

  const onAbort = () => { aborted = true; terminate(); };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  const timeoutTimer = setTimeout(() => { timedOut = true; terminate(); }, options.timeoutMs);
  timeoutTimer.unref?.();

  child.once("error", (error) => {
    const hint = (error as NodeJS.ErrnoException).code === "ENOENT"
      ? `CLI executable not found: ${spec.command}`
      : error.message;
    finishReject(new Error(hint));
  });
  child.once("close", (code, signal) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeoutTimer);
    if (forceTimer) clearTimeout(forceTimer);
    options.signal?.removeEventListener("abort", onAbort);
    resolve({ stdout, stderr, exitCode: code ?? 1, signal, timedOut, aborted });
  });
});

function textValue(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (Array.isArray(value)) {
    const joined = value.map(textValue).filter(Boolean).join("\n");
    return joined || undefined;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return textValue(record.text) ?? textValue(record.content) ?? textValue(record.summary);
  }
  return undefined;
}

function concise(value: string, max = 1_000): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** Convert public Codex JSONL events into a safe, user-facing execution trace. */
export function codexProgressFromEvent(event: Record<string, any>): CodingAgentProgress | undefined {
  if (event.type === "turn.started") return { kind: "status", message: "Codex started the turn." };
  if (event.type === "turn.failed") {
    return { kind: "error", message: concise(textValue(event.error) ?? "Codex turn failed.") };
  }
  if (event.type === "error") {
    return { kind: "error", message: concise(textValue(event.message) ?? textValue(event.error) ?? "Codex error.") };
  }
  if (event.type === "turn.completed") {
    const usage = event.usage && typeof event.usage === "object" ? event.usage : undefined;
    const suffix = usage?.output_tokens !== undefined ? ` (${usage.output_tokens} output tokens)` : "";
    return { kind: "status", message: `Codex completed the turn${suffix}.` };
  }
  if (event.type !== "item.started" && event.type !== "item.completed" && event.type !== "item.updated") {
    return undefined;
  }

  const item = event.item;
  if (!item || typeof item !== "object") return undefined;
  const completed = event.type === "item.completed";
  switch (item.type) {
    case "reasoning": {
      if (!completed) return undefined;
      const summary = textValue(item.text) ?? textValue(item.summary) ?? textValue(item.content);
      return summary ? { kind: "reasoning", message: concise(summary, 2_000) } : undefined;
    }
    case "command_execution": {
      const command = textValue(item.command);
      if (!command) return undefined;
      if (!completed) return { kind: "command", message: `Running: ${concise(command, 500)}` };
      const outcome = item.exit_code !== undefined ? `exit ${item.exit_code}` : textValue(item.status) ?? "completed";
      return { kind: "command", message: `${concise(command, 500)} → ${outcome}` };
    }
    case "file_change": {
      if (!completed) return undefined;
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const files = changes
        .map((change: any) => textValue(change?.path) ?? textValue(change?.file))
        .filter(Boolean)
        .slice(0, 20);
      return {
        kind: "file_change",
        message: files.length ? `Changed: ${files.join(", ")}` : "Codex applied file changes.",
      };
    }
    case "mcp_tool_call": {
      const name = [textValue(item.server), textValue(item.tool)].filter(Boolean).join("/")
        || textValue(item.name)
        || "MCP tool";
      return { kind: "tool", message: `${completed ? "Called" : "Calling"}: ${concise(name, 500)}` };
    }
    case "web_search": {
      const query = textValue(item.query) ?? "web search";
      return { kind: "tool", message: `${completed ? "Searched" : "Searching"}: ${concise(query, 500)}` };
    }
    case "plan":
    case "plan_update":
    case "todo_list": {
      if (!completed) return undefined;
      const plan = textValue(item.text) ?? textValue(item.plan) ?? textValue(item.items) ?? "Codex updated its plan.";
      return { kind: "plan", message: concise(plan, 2_000) };
    }
    case "agent_message":
      return completed ? { kind: "status", message: "Codex prepared the final response." } : undefined;
    default:
      return undefined;
  }
}

function decodeCodexLine(line: string): Record<string, any> | undefined {
  if (!line.trim()) return undefined;
  try { return JSON.parse(line) as Record<string, any>; } catch { return undefined; }
}

function codexJsonlDecoder(onEvent: (event: Record<string, any>) => void): {
  push(chunk: string): void;
  flush(): void;
} {
  let pending = "";
  const consume = (line: string) => {
    const event = decodeCodexLine(line);
    if (event) onEvent(event);
  };
  return {
    push(chunk) {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) consume(line);
    },
    flush() {
      if (pending) consume(pending);
      pending = "";
    },
  };
}

function parseCodex(stdout: string): { answer: string; trace: CodingAgentProgress[]; sessionId?: string } {
  let answer = "";
  let sessionId: string | undefined;
  const trace: CodingAgentProgress[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const event = decodeCodexLine(line);
    if (!event) continue;
    if (event.type === "thread.started" && typeof event.thread_id === "string") sessionId = event.thread_id;
    if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
      answer = event.item.text;
    }
    const progress = codexProgressFromEvent(event);
    if (progress) trace.push(progress);
  }
  return { answer: answer || stdout.trim(), trace, ...(sessionId ? { sessionId } : {}) };
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof (value as any).content === "string") return (value as any).content;
  return undefined;
}

function parseGrok(stdout: string): { answer: string; trace: CodingAgentProgress[]; sessionId?: string } {
  try {
    const data = JSON.parse(stdout) as Record<string, any>;
    const answer = stringValue(data.result) ?? stringValue(data.text) ?? stringValue(data.response) ?? stringValue(data.message) ?? stringValue(data.content);
    const sessionId = typeof data.sessionId === "string" ? data.sessionId : undefined;
    return { answer: answer ?? stdout.trim(), trace: [], ...(sessionId ? { sessionId } : {}) };
  } catch {
    return { answer: stdout.trim(), trace: [] };
  }
}

function parseGemini(stdout: string, mode: CodingAgentMode): { answer: string; trace: CodingAgentProgress[]; sessionId?: string } {
  const parsed = parseGeminiJson(stdout);
  if (parsed.error?.message) throw new Error(`gemini reported an error: ${parsed.error.message}`);
  if (mode === "review") {
    // Fail closed BEFORE any success path: a tampered review must never reach
    // a clean dokoro handoff (the MCP layer records the failure instead).
    const guard = reviewGuard(parsed);
    if (!guard.ok) throw new Error(`gemini review tamper guard: ${guard.reason}`);
  }
  return { answer: parsed.response ?? stdout.trim(), trace: [] };
}

function parseClaudeResult(stdout: string, mode: CodingAgentMode): { answer: string; trace: CodingAgentProgress[]; sessionId?: string } {
  const parsed = parseClaudeEnvelope(stdout);
  if (parsed.isError) {
    throw new Error(`claude worker error: ${concise(parsed.text ?? parsed.raw, 8_000)}`);
  }
  const answer = parsed.text ?? stdout.trim();
  // Headless acceptEdits denies Bash-class calls rather than prompting; a
  // write task that hit denials completed only partially — say so.
  const degraded = mode === "write" && parsed.deniedCalls > 0
    ? `\n\n⚠ ${parsed.deniedCalls} tool call(s) denied by headless permission limits — the task may be incomplete.`
    : "";
  return {
    answer: answer + degraded,
    trace: [],
    ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
  };
}

export async function runCodingAgent(
  args: RunCodingAgentArgs,
  executor: CommandExecutor = executeCommand,
  worktreeFactory: (repoCwd: string) => Promise<ReviewWorktree> = createReviewWorktree,
): Promise<CodingAgentResult> {
  // Defense in depth behind the MCP handler's early refusal: every worker env
  // carries TACHI_CODING_DEPTH, so a worker-driven re-entry lands here too.
  if (process.env.TACHI_CODING_DEPTH) {
    throw new Error("recursion guard: refusing to spawn a coding agent from inside a tachi-spawned worker");
  }
  if (!args.task?.trim()) throw new Error("coding agent task must not be empty");
  const cwd = await resolveCodingCwd(args.cwd);
  const mode = args.mode ?? "review";
  const visibility = args.visibility ?? "trace";
  const timeoutMs = clampInt(args.timeoutMs, DEFAULT_CODING_TIMEOUT_MS, 1_000, MAX_CODING_TIMEOUT_MS);
  const model = args.agent === "openrouter" ? openRouterCodingModel(args.model) : args.model?.trim();
  // Resolve the OpenRouter harness ONCE, before preflight: it decides which
  // binary we probe, how we parse stdout, and whether the run is isolated.
  // An unrecognized selector fails closed here, before anything is spawned.
  const harnessSpec = args.agent === "openrouter"
    ? buildOpenRouterHarnessSpec({ ...args, task: args.task.trim(), cwd, timeoutMs, mode, model })
    : undefined;
  const command = harnessSpec?.command.command ?? envCommand(args.agent);
  const pf = await preflightCodingAgent(args.agent, command, {
    env: process.env,
    hasBinary: async (cmd) => {
      // Resolve via the same PATH the child would use, shell-free. On POSIX
      // `command -v` is a shell builtin, so we invoke sh but pass cmd as the
      // positional $1 — never interpolated, so there is no injection surface.
      const { execFile } = await import("node:child_process");
      return await new Promise<boolean>((resolve) => {
        if (process.platform === "win32") {
          execFile("where", [cmd], (err) => resolve(!err));
        } else {
          execFile("/bin/sh", ["-c", 'command -v -- "$1" >/dev/null 2>&1', "sh", cmd], (err) => resolve(!err));
        }
      });
    },
    fileExists: async (p) => { try { await access(p); return true; } catch { return false; } },
  } satisfies PreflightDeps, harnessSpec ? { openRouterHarness: harnessSpec.harness } : {});
  if (!pf.ok) throw new Error(`${args.agent} preflight failed: ${pf.reason}`);
  // Gemini review runs in a throwaway detached-HEAD worktree: its headless
  // plan mode is not reliably read-only, so the requested checkout is never
  // the spawn cwd. The tamper guard then audits the disposable copy.
  const worktree = args.agent === "gemini" && mode === "review"
    ? await worktreeFactory(cwd)
    : undefined;
  const spec = harnessSpec?.command
    ?? buildCodingAgentCommand({ ...args, task: args.task.trim(), cwd: worktree?.dir ?? cwd, timeoutMs, mode, model });
  // Codex JSONL is a harness property, not an agent name: the codex-backed
  // OpenRouter harness emits it too, so it gets live streaming + the same parser.
  const outputKind: OpenRouterOutputKind = harnessSpec?.outputKind
    ?? (args.agent === "codex" ? "codex-jsonl" : "plain");
  let progressQueue = Promise.resolve();
  const publish = (update: CodingAgentProgress) => {
    if (visibility !== "live" || !args.onProgress) return;
    progressQueue = progressQueue.then(() => args.onProgress!(update)).catch(() => undefined);
  };
  publish({ kind: "status", message: `Starting ${args.agent} coding agent in ${mode} mode.` });
  const decoder = outputKind === "codex-jsonl" && visibility === "live"
    ? codexJsonlDecoder((event) => {
      const update = codexProgressFromEvent(event);
      if (update) publish(update);
    })
    : undefined;
  try {
    const processResult = await executor(spec, {
      timeoutMs,
      maxOutputChars: DEFAULT_MAX_OUTPUT_CHARS,
      signal: args.signal,
      ...(decoder ? { onStdout: decoder.push } : {}),
    });
    decoder?.flush();
    if (processResult.timedOut) {
      publish({ kind: "error", message: `${args.agent} timed out after ${timeoutMs}ms.` });
      await progressQueue;
      throw new Error(`${args.agent} coding agent timed out after ${timeoutMs}ms`);
    }
    if (processResult.aborted) {
      publish({ kind: "error", message: `${args.agent} was aborted.` });
      await progressQueue;
      throw new Error(`${args.agent} coding agent was aborted`);
    }
    if (processResult.exitCode !== 0) {
      const detail = processResult.stderr.trim() || processResult.stdout.trim() || `exit ${processResult.exitCode}`;
      publish({ kind: "error", message: `${args.agent} failed with exit ${processResult.exitCode}.` });
      await progressQueue;
      throw new Error(`${args.agent} coding agent failed: ${detail.slice(0, 8_000)}`);
    }

    const parsed = outputKind === "codex-jsonl"
      ? parseCodex(processResult.stdout)
      : args.agent === "grok"
        ? parseGrok(processResult.stdout)
        : args.agent === "gemini"
          ? parseGemini(processResult.stdout, mode)
          : args.agent === "claude"
            ? parseClaudeResult(processResult.stdout, mode)
            : { answer: processResult.stdout.trim(), trace: [] as CodingAgentProgress[] };
    const provider = args.agent === "openrouter" ? "openrouter" : args.provider?.trim();
    publish({ kind: "status", message: `${args.agent} coding agent completed successfully.` });
    await progressQueue;
    return {
      ...processResult,
      agent: args.agent,
      mode,
      cwd,
      ...(model ? { model } : {}),
      ...(provider ? { provider } : {}),
      // For OpenRouter the harness reports whether it relocated the run; only
      // hermes has a --worktree, so codex-backed runs stay on the requested checkout.
      isolated: harnessSpec
        ? harnessSpec.workspace === "worktree"
        : (args.agent === "hermes" && (mode === "review" || args.isolate !== false)) || Boolean(worktree),
      ...(harnessSpec ? { harness: harnessSpec.harness } : {}),
      answer: parsed.answer,
      ...(visibility !== "final" && parsed.trace.length ? { trace: parsed.trace } : {}),
      ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
    };
  } finally {
    await worktree?.cleanup();
  }
}
