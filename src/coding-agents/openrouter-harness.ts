/**
 * OpenRouter coding adapter.
 *
 * The public MCP contract stays a single agent name (`openrouter`); this module
 * decides which local CLI actually drives the OpenRouter model. Hermes is the
 * default harness and keeps its existing argv byte-for-byte. `TACHI_OPENROUTER_HARNESS`
 * selects an alternative and fails closed on anything unrecognized.
 *
 * The API key never appears in argv, only in the sanitized worker env built by
 * `buildWorkerEnv("openrouter", …)`.
 */
import { buildWorkerEnv } from "./worker-env.js";
// Type-only: erased at compile time, so this does not create a runtime import
// cycle with runner.ts (which imports this module for values).
import type { CodingAgentCommand, CodingAgentMode } from "./runner.js";

export type OpenRouterHarnessName = "hermes" | "codex";
export type OpenRouterOutputKind = "plain" | "codex-jsonl";

export interface OpenRouterHarnessArgs {
  task: string;
  cwd: string;
  model: string;
  mode: CodingAgentMode;
  isolate: boolean;
  maxTurns: number;
  timeoutMs: number;
}

export interface OpenRouterHarnessCommand {
  harness: OpenRouterHarnessName;
  /** How the caller must parse stdout. */
  outputKind: OpenRouterOutputKind;
  /** `worktree` means the harness itself relocates the run off the requested checkout. */
  workspace: "requested" | "worktree";
  command: CodingAgentCommand;
}

const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** Pick the harness from env; unset means hermes, unknown values fail closed. */
export function resolveOpenRouterHarness(env: NodeJS.ProcessEnv = process.env): OpenRouterHarnessName {
  const raw = env.TACHI_OPENROUTER_HARNESS?.trim();
  if (!raw) return "hermes";
  if (raw === "hermes" || raw === "codex") return raw;
  throw new Error(
    `TACHI_OPENROUTER_HARNESS must be "hermes" or "codex" (got "${raw}")`,
  );
}

function buildHermesCommand(args: OpenRouterHarnessArgs, env: NodeJS.ProcessEnv): OpenRouterHarnessCommand {
  const isolated = args.mode === "review" || args.isolate;
  const argv = [
    "chat",
    "--quiet",
    "--oneshot",
    "--in", args.cwd,
    "--toolsets", "file,terminal,skills",
    "--checkpoints",
    "--max-turns", String(args.maxTurns),
    "--run-budget", String(Math.max(1, Math.floor(args.timeoutMs / 1000))),
    "--source", "tool",
  ];
  if (args.mode === "write") argv.push("--yolo");
  argv.push("--provider", "openrouter");
  argv.push("--model", args.model);
  if (isolated) argv.push("--worktree");
  argv.push("--query", args.task);
  return {
    harness: "hermes",
    outputKind: "plain",
    workspace: isolated ? "worktree" : "requested",
    command: {
      command: env.HERMES_CLI?.trim() || "hermes",
      args: argv,
      cwd: args.cwd,
      env: buildWorkerEnv("openrouter", env),
    },
  };
}

function buildCodexCommand(args: OpenRouterHarnessArgs, env: NodeJS.ProcessEnv): OpenRouterHarnessCommand {
  const baseUrl = env.OPENROUTER_BASE_URL?.trim() || DEFAULT_OPENROUTER_BASE_URL;
  // `env_key` names the variable codex reads at runtime — the key itself stays
  // in the sanitized worker env and never becomes an argv value.
  const argv = [
    "exec",
    "--ephemeral",
    "--json",
    "--color", "never",
    "--sandbox", args.mode === "write" ? "workspace-write" : "read-only",
    "-C", args.cwd,
    "-c", 'model_provider="openrouter"',
    "-c", 'model_providers.openrouter.name="openrouter"',
    "-c", `model_providers.openrouter.base_url=${JSON.stringify(baseUrl)}`,
    "-c", 'model_providers.openrouter.env_key="OPENROUTER_API_KEY"',
    "-m", args.model,
    // End of options: the task can never be re-read as a flag.
    "--", args.task,
  ];
  return {
    harness: "codex",
    outputKind: "codex-jsonl",
    // Codex has no worktree flag; its sandbox constrains the requested checkout
    // in place, so `isolate` cannot be honored by relocating the run.
    workspace: "requested",
    command: {
      command: env.CODEX_CLI?.trim() || "codex",
      args: argv,
      cwd: args.cwd,
      env: buildWorkerEnv("openrouter", env),
    },
  };
}

/** Build the argv for the selected harness. Shell-free: task/model stay values. */
export function buildOpenRouterHarnessCommand(
  harness: OpenRouterHarnessName,
  args: OpenRouterHarnessArgs,
  env: NodeJS.ProcessEnv = process.env,
): OpenRouterHarnessCommand {
  return harness === "codex" ? buildCodexCommand(args, env) : buildHermesCommand(args, env);
}
