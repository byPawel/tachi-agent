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
  delete process.env.XAI_API_KEY;
  delete process.env.OPENROUTER_MODEL;
  delete process.env.TACHI_OPENROUTER_CODING_MODEL;
  delete process.env.TACHI_CODING_ROOTS;
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
