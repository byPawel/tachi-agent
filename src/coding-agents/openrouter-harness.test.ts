import { describe, expect, it } from "vitest";
import {
  buildOpenRouterHarnessCommand,
  resolveOpenRouterHarness,
  type OpenRouterHarnessArgs,
} from "./openrouter-harness.js";

const argsFor = (over: Partial<OpenRouterHarnessArgs> = {}): OpenRouterHarnessArgs => ({
  task: "review src",
  cwd: "/repo",
  model: "qwen/qwen3-coder",
  mode: "review",
  isolate: true,
  maxTurns: 40,
  timeoutMs: 600_000,
  ...over,
});

describe("resolveOpenRouterHarness", () => {
  it("defaults to hermes when unset", () => {
    expect(resolveOpenRouterHarness({})).toBe("hermes");
  });

  it("accepts each supported harness name", () => {
    expect(resolveOpenRouterHarness({ TACHI_OPENROUTER_HARNESS: "hermes" })).toBe("hermes");
    expect(resolveOpenRouterHarness({ TACHI_OPENROUTER_HARNESS: "codex" })).toBe("codex");
  });

  it("fails closed on an unknown harness, naming both valid values", () => {
    expect(() => resolveOpenRouterHarness({ TACHI_OPENROUTER_HARNESS: "aider" }))
      .toThrow(/TACHI_OPENROUTER_HARNESS.*hermes.*codex/i);
  });
});

describe("hermes OpenRouter harness", () => {
  it("forces --worktree for review even when isolation is declined", () => {
    const built = buildOpenRouterHarnessCommand("hermes", argsFor({ mode: "review", isolate: false }), {});
    expect(built.command.args).toContain("--worktree");
    expect(built.workspace).toBe("worktree");
  });

  it("keeps the requested workspace for a non-isolated write run", () => {
    const built = buildOpenRouterHarnessCommand("hermes", argsFor({ mode: "write", isolate: false }), {});
    expect(built.command.args).not.toContain("--worktree");
    expect(built.workspace).toBe("requested");
  });

  it("emits --yolo only in write mode", () => {
    expect(buildOpenRouterHarnessCommand("hermes", argsFor({ mode: "write" }), {}).command.args)
      .toContain("--yolo");
    expect(buildOpenRouterHarnessCommand("hermes", argsFor({ mode: "review" }), {}).command.args)
      .not.toContain("--yolo");
  });

  it("pins the OpenRouter provider and the exact model, and reports plain output", () => {
    const built = buildOpenRouterHarnessCommand("hermes", argsFor({ model: "deepseek/deepseek-v3.2" }), {});
    expect(built.harness).toBe("hermes");
    expect(built.outputKind).toBe("plain");
    expect(built.command.args).toEqual(expect.arrayContaining([
      "chat", "--quiet", "--oneshot",
      "--in", "/repo",
      "--toolsets", "file,terminal,skills",
      "--checkpoints",
      "--max-turns", "40",
      "--run-budget", "600",
      "--source", "tool",
      "--provider", "openrouter",
      "--model", "deepseek/deepseek-v3.2",
    ]));
    expect(built.command.args.at(-2)).toBe("--query");
    expect(built.command.args.at(-1)).toBe("review src");
  });

  it("honors HERMES_CLI and hands the worker a sanitized env", () => {
    const built = buildOpenRouterHarnessCommand("hermes", argsFor(), {
      PATH: "/bin",
      HERMES_CLI: "/opt/bin/hermes",
      OPENROUTER_API_KEY: "secret-value",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
    });
    expect(built.command.command).toBe("/opt/bin/hermes");
    expect(built.command.cwd).toBe("/repo");
    expect(built.command.env.OPENROUTER_API_KEY).toBe("secret-value");
    expect(built.command.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(built.command.env.TACHI_CODING_DEPTH).toBe("1");
    expect(built.command.args.join(" ")).not.toContain("secret-value");
  });

  it("falls back to the bare hermes binary with no override", () => {
    expect(buildOpenRouterHarnessCommand("hermes", argsFor(), {}).command.command).toBe("hermes");
  });
});

describe("codex OpenRouter harness", () => {
  it("is not implemented yet", () => {
    expect(() => buildOpenRouterHarnessCommand("codex", argsFor(), {}))
      .toThrow(/codex OpenRouter harness is not implemented/i);
  });
});
