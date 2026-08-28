import { spawn, type ChildProcess } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

export type CodingAgentName = "codex" | "grok" | "hermes" | "openrouter";
export type CodingAgentMode = "review" | "write";

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
  signal?: AbortSignal;
}

export interface CodingAgentCommand {
  command: string;
  args: string[];
  cwd: string;
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
  answer: string;
  sessionId?: string;
}

export type CommandExecutor = (
  spec: CodingAgentCommand,
  options: { timeoutMs: number; maxOutputChars: number; signal?: AbortSignal },
) => Promise<ProcessResult>;

export const DEFAULT_CODING_TIMEOUT_MS = 600_000;
export const MAX_CODING_TIMEOUT_MS = 3_600_000;
export const DEFAULT_MAX_OUTPUT_CHARS = 2_000_000;

const REVIEW_TOOLS = "read_file,grep,list_dir,run_terminal_cmd";

function envCommand(name: CodingAgentName): string {
  const key = name === "openrouter" ? "HERMES_CLI" : `${name.toUpperCase()}_CLI`;
  return process.env[key]?.trim() || (name === "openrouter" ? "hermes" : name);
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value!)));
}

/** Build argv without a shell: tasks/models are values, never executable syntax. */
export function buildCodingAgentCommand(args: RunCodingAgentArgs & { cwd: string }): CodingAgentCommand {
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
    argv.push(args.task);
    return { command: envCommand("codex"), args: argv, cwd: args.cwd };
  }

  if (args.agent === "grok") {
    const argv = [
      "--no-auto-update",
      "-p", args.task,
      "--cwd", args.cwd,
      "--output-format", "json",
      "--sandbox", mode === "write" ? "workspace" : "read-only",
      "--always-approve",
      "--max-turns", String(maxTurns),
    ];
    if (mode === "review") argv.push("--tools", REVIEW_TOOLS);
    if (args.model?.trim()) argv.push("-m", args.model.trim());
    return { command: envCommand("grok"), args: argv, cwd: args.cwd };
  }

  const provider = args.agent === "openrouter" ? "openrouter" : args.provider?.trim();
  if (args.agent === "openrouter" && !args.model?.trim()) {
    throw new Error("openrouter coding agent requires an explicit model id");
  }
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
    "--yolo",
  ];
  if (provider) argv.push("--provider", provider);
  if (args.model?.trim()) argv.push("--model", args.model.trim());
  if (isolated) argv.push("--worktree");
  argv.push("--query", args.task);
  return { command: envCommand(args.agent), args: argv, cwd: args.cwd };
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
    env: process.env,
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
    if (stream === "stdout") stdout += chunk.toString("utf8");
    else stderr += chunk.toString("utf8");
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

function parseCodex(stdout: string): { answer: string; sessionId?: string } {
  let answer = "";
  let sessionId: string | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, any>;
      if (event.type === "thread.started" && typeof event.thread_id === "string") sessionId = event.thread_id;
      if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
        answer = event.item.text;
      }
    } catch { /* keep scanning JSONL */ }
  }
  return { answer: answer || stdout.trim(), ...(sessionId ? { sessionId } : {}) };
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof (value as any).content === "string") return (value as any).content;
  return undefined;
}

function parseGrok(stdout: string): { answer: string; sessionId?: string } {
  try {
    const data = JSON.parse(stdout) as Record<string, any>;
    const answer = stringValue(data.result) ?? stringValue(data.response) ?? stringValue(data.message) ?? stringValue(data.content);
    const sessionId = typeof data.sessionId === "string" ? data.sessionId : undefined;
    return { answer: answer ?? stdout.trim(), ...(sessionId ? { sessionId } : {}) };
  } catch {
    return { answer: stdout.trim() };
  }
}

export async function runCodingAgent(
  args: RunCodingAgentArgs,
  executor: CommandExecutor = executeCommand,
): Promise<CodingAgentResult> {
  if (!args.task?.trim()) throw new Error("coding agent task must not be empty");
  const cwd = await resolveCodingCwd(args.cwd);
  const mode = args.mode ?? "review";
  const timeoutMs = clampInt(args.timeoutMs, DEFAULT_CODING_TIMEOUT_MS, 1_000, MAX_CODING_TIMEOUT_MS);
  const spec = buildCodingAgentCommand({ ...args, task: args.task.trim(), cwd, timeoutMs, mode });
  const processResult = await executor(spec, {
    timeoutMs,
    maxOutputChars: DEFAULT_MAX_OUTPUT_CHARS,
    signal: args.signal,
  });
  if (processResult.timedOut) throw new Error(`${args.agent} coding agent timed out after ${timeoutMs}ms`);
  if (processResult.aborted) throw new Error(`${args.agent} coding agent was aborted`);
  if (processResult.exitCode !== 0) {
    const detail = processResult.stderr.trim() || processResult.stdout.trim() || `exit ${processResult.exitCode}`;
    throw new Error(`${args.agent} coding agent failed: ${detail.slice(0, 8_000)}`);
  }

  const parsed = args.agent === "codex"
    ? parseCodex(processResult.stdout)
    : args.agent === "grok"
      ? parseGrok(processResult.stdout)
      : { answer: processResult.stdout.trim() };
  const provider = args.agent === "openrouter" ? "openrouter" : args.provider?.trim();
  return {
    ...processResult,
    agent: args.agent,
    mode,
    cwd,
    ...(args.model?.trim() ? { model: args.model.trim() } : {}),
    ...(provider ? { provider } : {}),
    isolated: (args.agent === "hermes" || args.agent === "openrouter") && (mode === "review" || args.isolate !== false),
    answer: parsed.answer,
    ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
  };
}
