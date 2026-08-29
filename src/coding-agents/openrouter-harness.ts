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

/** Build the argv for the selected harness. Shell-free: task/model stay values. */
export function buildOpenRouterHarnessCommand(
  harness: OpenRouterHarnessName,
  args: OpenRouterHarnessArgs,
  env: NodeJS.ProcessEnv = process.env,
): OpenRouterHarnessCommand {
  if (harness === "codex") throw new Error("codex OpenRouter harness is not implemented");
  return buildHermesCommand(args, env);
}
