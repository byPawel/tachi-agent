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
  const codexEnv = {
    PATH: "/bin",
    CODEX_CLI: "/usr/local/bin/codex",
    OPENROUTER_API_KEY: "secret-value",
  } as NodeJS.ProcessEnv;

  it("drives codex against OpenRouter without leaking the key into argv", () => {
    const built = buildOpenRouterHarnessCommand(
      "codex",
      argsFor({ task: "review src", model: "z-ai/glm-5.3-flash", mode: "review", isolate: true }),
      codexEnv,
    );
    expect(built.harness).toBe("codex");
    expect(built.outputKind).toBe("codex-jsonl");
    // Codex sandboxes in place; it has no worktree flag of its own.
    expect(built.workspace).toBe("requested");
    expect(built.command.command).toBe("/usr/local/bin/codex");
    expect(built.command.cwd).toBe("/repo");
    expect(built.command.args).toEqual(expect.arrayContaining([
      "exec", "--ephemeral", "--json",
      "--sandbox", "read-only",
      "-C", "/repo",
      "-m", "z-ai/glm-5.3-flash",
    ]));
    expect(built.command.args.slice(-2)).toEqual(["--", "review src"]);
    // Auth travels in the env only — never argv, logs, or config files.
    expect(built.command.args.join(" ")).not.toContain("secret-value");
    expect(built.command.env.OPENROUTER_API_KEY).toBe("secret-value");
  });

  it("points codex at the OpenRouter provider via -c overrides", () => {
    const built = buildOpenRouterHarnessCommand("codex", argsFor(), codexEnv);
    expect(built.command.args).toEqual(expect.arrayContaining([
      "-c", 'model_provider="openrouter"',
      "-c", 'model_providers.openrouter.name="openrouter"',
      "-c", 'model_providers.openrouter.base_url="https://openrouter.ai/api/v1"',
      "-c", 'model_providers.openrouter.env_key="OPENROUTER_API_KEY"',
    ]));
  });

  it("quotes a custom OPENROUTER_BASE_URL into the config override", () => {
    const built = buildOpenRouterHarnessCommand("codex", argsFor(), {
      ...codexEnv,
      OPENROUTER_BASE_URL: " https://gateway.internal/v1 ",
    });
    expect(built.command.args).toContain('model_providers.openrouter.base_url="https://gateway.internal/v1"');
    expect(built.command.env.OPENROUTER_BASE_URL).toBe(" https://gateway.internal/v1 ");
  });

  it("uses the workspace-write sandbox only in write mode", () => {
    const write = buildOpenRouterHarnessCommand("codex", argsFor({ mode: "write" }), codexEnv);
    expect(write.command.args).toEqual(expect.arrayContaining(["--sandbox", "workspace-write"]));
    expect(write.command.args).not.toContain("read-only");
    const review = buildOpenRouterHarnessCommand("codex", argsFor({ mode: "review" }), codexEnv);
    expect(review.command.args).toEqual(expect.arrayContaining(["--sandbox", "read-only"]));
    expect(review.command.args).not.toContain("workspace-write");
  });

  it("emits no hermes flags", () => {
    const built = buildOpenRouterHarnessCommand("codex", argsFor({ mode: "write", isolate: true }), codexEnv);
    for (const flag of ["--query", "--worktree", "--oneshot", "--provider", "--yolo", "--toolsets"]) {
      expect(built.command.args).not.toContain(flag);
    }
  });

  it("falls back to the bare codex binary with no override", () => {
    expect(buildOpenRouterHarnessCommand("codex", argsFor(), {}).command.command).toBe("codex");
  });
});
