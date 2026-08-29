import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCodingAgentCommand,
  runCodingAgent,
  writeAuthorized,
  type CommandExecutor,
  type ProcessResult,
} from "../runner.js";

const CWD = process.cwd();
const ok = (stdout: string): ProcessResult => ({
  stdout,
  stderr: "",
  exitCode: 0,
  signal: null,
  timedOut: false,
  aborted: false,
});

afterEach(() => {
  delete process.env.CODEX_CLI;
  delete process.env.GROK_CLI;
  delete process.env.HERMES_CLI;
  delete process.env.GEMINI_CLI;
  delete process.env.GEMINI_API_KEY;
  delete process.env.CLAUDE_CLI;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.XAI_API_KEY;
  delete process.env.OPENROUTER_MODEL;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.TACHI_OPENROUTER_CODING_MODEL;
  delete process.env.TACHI_OPENROUTER_HARNESS;
  delete process.env.TACHI_CODING_ROOTS;
  delete process.env.TACHI_CODING_DEPTH;
});

describe("buildCodingAgentCommand", () => {
  it("builds shell-free Codex review argv", () => {
    const task = "review $(touch /tmp/nope) `whoami`";
    const spec = buildCodingAgentCommand({ agent: "codex", task, cwd: CWD, model: "gpt-5.6", mode: "review" });
    expect(spec.command).toBe("codex");
    expect(spec.args).toContain("read-only");
    expect(spec.args).toContain("gpt-5.6");
    expect(spec.args.at(-1)).toBe(task);
  });

  it("maps Grok write mode to its workspace sandbox", () => {
    const spec = buildCodingAgentCommand({ agent: "grok", task: "fix it", cwd: CWD, mode: "write", maxTurns: 9 });
    expect(spec.args).toEqual(expect.arrayContaining(["--sandbox", "workspace", "--always-approve", "--max-turns", "9"]));
    expect(spec.args).not.toContain("read_file,grep,list_dir,run_terminal_cmd");
  });

  it("forces Hermes review runs into an isolated worktree", () => {
    const spec = buildCodingAgentCommand({ agent: "hermes", task: "review", cwd: CWD, mode: "review", isolate: false });
    expect(spec.args).toContain("--worktree");
    expect(spec.args).toEqual(expect.arrayContaining(["--checkpoints", "--toolsets", "file,terminal,skills"]));
  });

  it("requires a per-run model for the OpenRouter shortcut", () => {
    expect(() => buildCodingAgentCommand({ agent: "openrouter", task: "x", cwd: CWD })).toThrow(/explicit model/i);
    const spec = buildCodingAgentCommand({ agent: "openrouter", task: "x", cwd: CWD, model: "qwen/qwen3-coder" });
    expect(spec.args).toEqual(expect.arrayContaining(["--provider", "openrouter", "--model", "qwen/qwen3-coder"]));
    expect(spec.args).toEqual(expect.arrayContaining(["--source", "tool"]));
  });

  it("uses the configured OpenRouter coding model when the call omits one", () => {
    process.env.TACHI_OPENROUTER_CODING_MODEL = "deepseek/deepseek-v3.2";
    const spec = buildCodingAgentCommand({ agent: "openrouter", task: "x", cwd: CWD });
    expect(spec.args).toEqual(expect.arrayContaining(["--model", "deepseek/deepseek-v3.2"]));
  });

  it("terminates Codex flag parsing with -- before the positional task", () => {
    const spec = buildCodingAgentCommand({ agent: "codex", task: "review this", cwd: CWD, mode: "review" });
    expect(spec.args.at(-2)).toBe("--");
    expect(spec.args.at(-1)).toBe("review this");
  });

  it("rejects tasks that start with a dash for every agent", () => {
    for (const agent of ["codex", "grok", "hermes", "openrouter"] as const) {
      expect(() => buildCodingAgentCommand({ agent, task: "-rf /", cwd: CWD, model: "m" }))
        .toThrow(/must not start with "-"/);
      expect(() => buildCodingAgentCommand({ agent, task: "  --help", cwd: CWD, model: "m" }))
        .toThrow(/must not start with "-"/);
    }
  });

  it("accepts tasks that merely contain dashes", () => {
    const spec = buildCodingAgentCommand({ agent: "codex", task: "Task: -rf is dangerous", cwd: CWD });
    expect(spec.args.at(-1)).toBe("Task: -rf is dangerous");
  });

  it("builds gemini review argv in plan approval mode without yolo", () => {
    const spec = buildCodingAgentCommand({ agent: "gemini", task: "review src", cwd: CWD, mode: "review", model: "gemini-2.5-pro" });
    expect(spec.command).toBe("gemini");
    expect(spec.args).toEqual(expect.arrayContaining(["-p", "review src", "--output-format", "json", "--approval-mode", "plan", "-m", "gemini-2.5-pro"]));
    expect(spec.args).not.toContain("--yolo");
  });

  it("emits --yolo for gemini only in write mode", () => {
    const spec = buildCodingAgentCommand({ agent: "gemini", task: "fix it", cwd: CWD, mode: "write" });
    expect(spec.args).toContain("--yolo");
    expect(spec.args).not.toContain("--approval-mode");
  });

  it("builds claude review argv in plan permission mode with strict mcp config", () => {
    const spec = buildCodingAgentCommand({ agent: "claude", task: "review src", cwd: CWD, mode: "review", maxTurns: 12, model: "claude-sonnet-5" });
    expect(spec.command).toBe("claude");
    expect(spec.args).toEqual(expect.arrayContaining([
      "-p", "review src", "--output-format", "json",
      "--permission-mode", "plan", "--strict-mcp-config",
      "--max-turns", "12", "--model", "claude-sonnet-5",
    ]));
    expect(spec.args).not.toContain("acceptEdits");
  });

  it("claude write mode uses acceptEdits and keeps user-config isolation", () => {
    const spec = buildCodingAgentCommand({ agent: "claude", task: "fix it", cwd: CWD, mode: "write" });
    expect(spec.args).toEqual(expect.arrayContaining(["--permission-mode", "acceptEdits", "--strict-mcp-config"]));
    expect(spec.args).not.toContain("plan");
  });
});

describe("runCodingAgent", () => {
  it("extracts the final Codex agent message and thread id from JSONL", async () => {
    const executor: CommandExecutor = vi.fn(async () => ok([
      JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "Inspect the affected module." } }),
      JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "npm test" } }),
      JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "npm test", exit_code: 0 } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }),
    ].join("\n")));
    const result = await runCodingAgent({ agent: "codex", task: "x", cwd: CWD }, executor);
    expect(result.answer).toBe("done");
    expect(result.sessionId).toBe("thread-1");
    expect(result.trace).toEqual(expect.arrayContaining([
      { kind: "reasoning", message: "Inspect the affected module." },
      { kind: "command", message: "npm test → exit 0" },
    ]));
  });

  it("streams complete Codex JSONL events in live visibility mode", async () => {
    const lines = [
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "Check the tests." } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }),
    ];
    const onProgress = vi.fn(async () => undefined);
    const executor: CommandExecutor = vi.fn(async (_spec, options) => {
      options.onStdout?.(`${lines[0]}\n${lines[1].slice(0, 20)}`);
      options.onStdout?.(`${lines[1].slice(20)}\n${lines[2]}\n`);
      return ok(lines.join("\n"));
    });

    await runCodingAgent(
      { agent: "codex", task: "x", cwd: CWD, visibility: "live", onProgress },
      executor,
    );

    expect(onProgress).toHaveBeenCalledWith({ kind: "reasoning", message: "Check the tests." });
    expect(onProgress).toHaveBeenCalledWith({ kind: "status", message: "codex coding agent completed successfully." });
  });

  it("suppresses the completed trace in final visibility mode", async () => {
    const stdout = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } });
    const result = await runCodingAgent(
      { agent: "codex", task: "x", cwd: CWD, visibility: "final" },
      async () => ok(stdout),
    );
    expect(result.trace).toBeUndefined();
  });

  it("extracts Grok JSON output", async () => {
    // Preflight now gates the spawn; point it at a present binary + key so the
    // mocked executor (never actually run) is still reached on any host.
    process.env.GROK_CLI = process.execPath;
    process.env.XAI_API_KEY = "test-key";
    const result = await runCodingAgent(
      { agent: "grok", task: "x", cwd: CWD },
      async () => ok(JSON.stringify({ result: "review complete", sessionId: "grok-1" })),
    );
    expect(result.answer).toBe("review complete");
    expect(result.sessionId).toBe("grok-1");
  });

  it("surfaces non-zero CLI exits", async () => {
    await expect(runCodingAgent(
      { agent: "codex", task: "x", cwd: CWD },
      async () => ({ ...ok(""), exitCode: 2, stderr: "auth required" }),
    )).rejects.toThrow(/auth required/);
  });
});

describe("worker env minimization", () => {
  it("codex command carries a minimal env, not full process.env", () => {
    const spec = buildCodingAgentCommand({ agent: "codex", task: "t", cwd: process.cwd(), mode: "review" });
    expect(spec.env).toBeDefined();
    expect(spec.env!.PATH).toBeDefined();
    // a secret unrelated to codex must not be forwarded
    expect(spec.env!.GATEWAY_TOKENS).toBeUndefined();
  });
});

describe("auto-approve gating", () => {
  it("grok review mode omits --always-approve and adds --no-subagents", () => {
    const spec = buildCodingAgentCommand({ agent: "grok", task: "t", cwd: process.cwd(), mode: "review" });
    expect(spec.args).not.toContain("--always-approve");
    expect(spec.args).toContain("--no-subagents");
  });
  it("grok write mode includes --always-approve", () => {
    const spec = buildCodingAgentCommand({ agent: "grok", task: "t", cwd: process.cwd(), mode: "write" });
    expect(spec.args).toContain("--always-approve");
  });
  it("hermes review omits --yolo", () => {
    const spec = buildCodingAgentCommand({ agent: "hermes", task: "t", cwd: process.cwd(), mode: "review" });
    expect(spec.args).not.toContain("--yolo");
  });
});

describe("writeAuthorized", () => {
  it("review is always allowed", () => expect(writeAuthorized({ mode: "review" })).toBe(true));
  it("write requires TACHI_CODING_ALLOW_WRITE=1", () => {
    expect(writeAuthorized({ mode: "write", env: {} })).toBe(false);
    expect(writeAuthorized({ mode: "write", env: { TACHI_CODING_ALLOW_WRITE: "1" } })).toBe(true);
  });
});

describe("preflight", () => {
  it("throws the preflight reason instead of spawning when creds are absent", async () => {
    await expect(runCodingAgent(
      { agent: "openrouter", task: "t", model: "x/y" },
      // executor that would fail if reached
      async () => { throw new Error("should not spawn"); },
    )).rejects.toThrow(/OPENROUTER_API_KEY|not found on PATH/i);
  });
});

describe("openrouter harness execution", () => {
  const codexHarness = () => {
    process.env.TACHI_OPENROUTER_HARNESS = "codex";
    process.env.CODEX_CLI = process.execPath;
    process.env.OPENROUTER_API_KEY = "test-key";
  };
  const hermesHarness = () => {
    process.env.HERMES_CLI = process.execPath;
    process.env.OPENROUTER_API_KEY = "test-key";
  };
  const codexJsonl = [
    JSON.stringify({ type: "thread.started", thread_id: "or-thread-1" }),
    JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "Inspect files." } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "review complete" } }),
  ];

  it("parses codex JSONL and reports the harness when the codex harness is selected", async () => {
    codexHarness();
    const executor: CommandExecutor = vi.fn(async () => ok(codexJsonl.join("\n")));
    const result = await runCodingAgent(
      { agent: "openrouter", model: "z-ai/glm-5.3-flash", task: "review", cwd: CWD },
      executor,
    );
    expect(result.agent).toBe("openrouter");
    expect(result.provider).toBe("openrouter");
    expect(result.harness).toBe("codex");
    expect(result.model).toBe("z-ai/glm-5.3-flash");
    expect(result.answer).toBe("review complete");
    expect(result.sessionId).toBe("or-thread-1");
    expect(result.trace).toEqual(expect.arrayContaining([
      { kind: "reasoning", message: "Inspect files." },
    ]));
    // Codex constrains the requested checkout in place; there is no worktree.
    expect(result.isolated).toBe(false);
  });

  it("preflights the codex binary, not hermes, when the codex harness is selected", async () => {
    process.env.TACHI_OPENROUTER_HARNESS = "codex";
    process.env.OPENROUTER_API_KEY = "test-key";
    process.env.CODEX_CLI = "/definitely/not/on/path/codex";
    await expect(runCodingAgent(
      { agent: "openrouter", model: "z-ai/glm-5.3-flash", task: "review", cwd: CWD },
      async () => { throw new Error("should not spawn"); },
    )).rejects.toThrow(/openrouter\/codex CLI "\/definitely\/not\/on\/path\/codex" not found on PATH/);
  });

  it("streams live codex progress for the codex-backed openrouter harness", async () => {
    codexHarness();
    const onProgress = vi.fn(async () => undefined);
    const executor: CommandExecutor = vi.fn(async (_spec, options) => {
      options.onStdout?.(`${codexJsonl[0]}\n${codexJsonl[1].slice(0, 20)}`);
      options.onStdout?.(`${codexJsonl[1].slice(20)}\n${codexJsonl[2]}\n`);
      return ok(codexJsonl.join("\n"));
    });
    await runCodingAgent(
      { agent: "openrouter", model: "z-ai/glm-5.3-flash", task: "review", cwd: CWD, visibility: "live", onProgress },
      executor,
    );
    expect(onProgress).toHaveBeenCalledWith({ kind: "reasoning", message: "Inspect files." });
  });

  it("keeps plain output and worktree isolation for the default hermes harness", async () => {
    hermesHarness();
    const executor: CommandExecutor = vi.fn(async () => ok("review complete\n"));
    const result = await runCodingAgent(
      { agent: "openrouter", model: "z-ai/glm-5.3-flash", task: "review", cwd: CWD },
      executor,
    );
    expect(result.harness).toBe("hermes");
    expect(result.answer).toBe("review complete");
    expect(result.isolated).toBe(true);
    expect(result.trace).toBeUndefined();
    expect(executor).toHaveBeenCalledWith(
      expect.objectContaining({
        command: process.execPath,
        args: expect.arrayContaining(["--worktree", "--provider", "openrouter"]),
      }),
      expect.anything(),
    );
  });

  it("reports the hermes harness un-isolated when isolate is declined in write mode", async () => {
    hermesHarness();
    process.env.TACHI_CODING_ALLOW_WRITE = "1";
    try {
      const result = await runCodingAgent(
        { agent: "openrouter", model: "z-ai/glm-5.3-flash", task: "fix it", cwd: CWD, mode: "write", isolate: false },
        async () => ok("patched"),
      );
      expect(result.harness).toBe("hermes");
      expect(result.isolated).toBe(false);
    } finally {
      delete process.env.TACHI_CODING_ALLOW_WRITE;
    }
  });

  it("fails closed on an unrecognized harness selector", async () => {
    process.env.TACHI_OPENROUTER_HARNESS = "bogus";
    process.env.OPENROUTER_API_KEY = "test-key";
    await expect(runCodingAgent(
      { agent: "openrouter", model: "z-ai/glm-5.3-flash", task: "review", cwd: CWD },
      async () => { throw new Error("should not spawn"); },
    )).rejects.toThrow(/TACHI_OPENROUTER_HARNESS/);
  });

  it("leaves the native codex agent free of harness metadata", async () => {
    process.env.CODEX_CLI = process.execPath;
    const result = await runCodingAgent(
      { agent: "codex", task: "x", cwd: CWD },
      async () => ok(codexJsonl.join("\n")),
    );
    expect(result.harness).toBeUndefined();
    expect(result.provider).toBeUndefined();
    expect(result.answer).toBe("review complete");
  });
});

describe("gemini worker execution", () => {
  const geminiEnv = () => {
    process.env.GEMINI_CLI = process.execPath;
    process.env.GEMINI_API_KEY = "test-key";
  };
  const cleanOk = JSON.stringify({
    response: "looks good",
    stats: { files: { totalLinesAdded: 0, totalLinesRemoved: 0 }, tools: { byName: { read_file: 2 } } },
  });

  it("runs review mode inside a throwaway worktree and cleans it up", async () => {
    geminiEnv();
    const cleanup = vi.fn(async () => undefined);
    const worktree = vi.fn(async () => ({ dir: CWD, cleanup }));
    const executor: CommandExecutor = vi.fn(async (spec) => {
      expect(spec.cwd).toBe(CWD); // worktree dir, not the requested checkout
      return ok(cleanOk);
    });
    const result = await runCodingAgent({ agent: "gemini", task: "review src", cwd: CWD }, executor, worktree);
    expect(worktree).toHaveBeenCalledWith(CWD);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(result.answer).toBe("looks good");
    expect(result.isolated).toBe(true);
  });

  it("fails the run when the tamper guard trips, and still cleans up", async () => {
    geminiEnv();
    const cleanup = vi.fn(async () => undefined);
    const worktree = vi.fn(async () => ({ dir: CWD, cleanup }));
    const tampered = JSON.stringify({
      response: "done",
      stats: { files: { totalLinesAdded: 4, totalLinesRemoved: 0 } },
    });
    await expect(runCodingAgent(
      { agent: "gemini", task: "review src", cwd: CWD },
      async () => ok(tampered),
      worktree,
    )).rejects.toThrow(/tamper guard/i);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("write mode skips the worktree and surfaces gemini-reported errors", async () => {
    geminiEnv();
    const worktree = vi.fn(async () => ({ dir: "/never", cleanup: async () => undefined }));
    const failed = JSON.stringify({ error: { type: "ApiError", message: "quota exhausted" } });
    await expect(runCodingAgent(
      { agent: "gemini", task: "fix it", cwd: CWD, mode: "write" },
      async () => ok(failed),
      worktree,
    )).rejects.toThrow(/quota exhausted/);
    expect(worktree).not.toHaveBeenCalled();
  });
});

describe("claude worker execution", () => {
  const claudeEnv = () => {
    process.env.CLAUDE_CLI = process.execPath;
    process.env.ANTHROPIC_API_KEY = "test-key";
  };

  it("review mode extracts the plan from ExitPlanMode denials", async () => {
    claudeEnv();
    const envelope = JSON.stringify({
      type: "result",
      is_error: false,
      result: "Claude requested permissions to exit plan mode, but you haven't granted it.",
      session_id: "sess-42",
      permission_denials: [
        { tool_name: "Bash", tool_input: { command: "ls" } },
        { tool_name: "ExitPlanMode", tool_input: { plan: "## Plan\n1. Look\n2. Report" } },
      ],
    });
    const result = await runCodingAgent(
      { agent: "claude", task: "plan a refactor", cwd: CWD },
      async () => ok(envelope),
    );
    expect(result.answer).toBe("## Plan\n1. Look\n2. Report");
    expect(result.sessionId).toBe("sess-42");
  });

  it("write mode surfaces denied tool calls as a degradation warning", async () => {
    claudeEnv();
    const envelope = JSON.stringify({
      type: "result",
      is_error: false,
      result: "Edited 2 files. Could not run the test suite.",
      permission_denials: [
        { tool_name: "Bash", tool_input: { command: "npm test" } },
        { tool_name: "WebFetch", tool_input: {} },
      ],
    });
    const result = await runCodingAgent(
      { agent: "claude", task: "fix and test", cwd: CWD, mode: "write" },
      async () => ok(envelope),
    );
    expect(result.answer).toContain("Edited 2 files.");
    expect(result.answer).toMatch(/2 tool call/);
    expect(result.answer).toMatch(/denied/);
  });

  it("fails closed on error envelopes", async () => {
    claudeEnv();
    const envelope = JSON.stringify({ type: "result", is_error: true, result: "credit balance too low" });
    await expect(runCodingAgent(
      { agent: "claude", task: "t", cwd: CWD },
      async () => ok(envelope),
    )).rejects.toThrow(/credit balance too low/);
  });
});

describe("recursion guard", () => {
  it("refuses to spawn any worker when TACHI_CODING_DEPTH is already set", async () => {
    process.env.CODEX_CLI = process.execPath;
    process.env.TACHI_CODING_DEPTH = "1";
    const executor = vi.fn(async () => ok("nope"));
    await expect(runCodingAgent({ agent: "codex", task: "t", cwd: CWD }, executor))
      .rejects.toThrow(/recursion guard/i);
    expect(executor).not.toHaveBeenCalled();
  });
});
