import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCodingAgentCommand,
  runCodingAgent,
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
  });
});

describe("runCodingAgent", () => {
  it("extracts the final Codex agent message and thread id from JSONL", async () => {
    const executor: CommandExecutor = vi.fn(async () => ok([
      JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }),
    ].join("\n")));
    const result = await runCodingAgent({ agent: "codex", task: "x", cwd: CWD }, executor);
    expect(result.answer).toBe("done");
    expect(result.sessionId).toBe("thread-1");
  });

  it("extracts Grok JSON output", async () => {
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
