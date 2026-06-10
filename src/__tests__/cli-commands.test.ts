/**
 * Tests for cli-commands.ts — queue/run visibility subcommands.
 * TDD: written before the implementation.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, writeFile, rm } from "node:fs/promises";

import {
  parseCliArgs,
  taskAdd,
  taskList,
  taskShow,
  runsLog,
  type CliDeps,
} from "../cli-commands.js";

// ---------------------------------------------------------------------------
// parseCliArgs
// ---------------------------------------------------------------------------
describe("parseCliArgs", () => {
  it("task add with plain text", () => {
    const result = parseCliArgs(["task", "add", "do something useful"]);
    expect(result).toMatchObject({ command: "task-add", text: "do something useful" });
  });

  it("task add with multiple words (joins)", () => {
    const result = parseCliArgs(["task", "add", "do", "something", "useful"]);
    expect(result).toMatchObject({ command: "task-add", text: "do something useful" });
  });

  it("task add with --driver flag", () => {
    const result = parseCliArgs(["task", "add", "my task", "--driver", "openai"]);
    expect(result).toMatchObject({ command: "task-add", text: "my task", driver: "openai" });
  });

  it("task add with --max-attempts flag", () => {
    const result = parseCliArgs(["task", "add", "my task", "--max-attempts", "2"]);
    expect(result).toMatchObject({ command: "task-add", text: "my task", maxAttempts: 2 });
  });

  it("task add with both flags", () => {
    const result = parseCliArgs(["task", "add", "my task", "--driver", "openai", "--max-attempts", "3"]);
    expect(result).toMatchObject({ command: "task-add", text: "my task", driver: "openai", maxAttempts: 3 });
  });

  it("task add flags before text words (flags extracted anywhere)", () => {
    const result = parseCliArgs(["task", "add", "--driver", "openai", "my", "task"]);
    expect(result.command).toBe("task-add");
    if (result.command !== "task-add") throw new Error("expected task-add"); // narrow the union for tsc
    expect(result.driver).toBe("openai");
    expect(result.text).toBe("my task");
  });

  it("task list", () => {
    expect(parseCliArgs(["task", "list"])).toMatchObject({ command: "task-list" });
  });

  it("task show with id", () => {
    expect(parseCliArgs(["task", "show", "abc-123"])).toMatchObject({ command: "task-show", id: "abc-123" });
  });

  it("runs log with id", () => {
    expect(parseCliArgs(["runs", "log", "run-456"])).toMatchObject({ command: "runs-log", id: "run-456" });
  });

  it("falls back to run for unknown command", () => {
    const result = parseCliArgs(["summarize", "my", "day"]);
    expect(result).toMatchObject({ command: "run", text: "summarize my day" });
  });

  it("empty argv opens chat", () => {
    expect(parseCliArgs([])).toEqual({ command: "chat" });
  });

  it("falls back to run for single non-keyword word", () => {
    const result = parseCliArgs(["hello"]);
    expect(result).toMatchObject({ command: "run", text: "hello" });
  });

  // --- chat-by-default + --driver/--skill flags ------------------------------

  it("--driver alone opens chat with the driver", () => {
    expect(parseCliArgs(["--driver", "openai"])).toEqual({ command: "chat", driver: "openai" });
  });

  it("--skill alone opens chat with the skill", () => {
    expect(parseCliArgs(["--skill", "researcher"])).toEqual({ command: "chat", skill: "researcher" });
  });

  it("--driver and --skill together open chat with both", () => {
    expect(parseCliArgs(["--driver", "openai", "--skill", "researcher"])).toEqual({
      command: "chat",
      driver: "openai",
      skill: "researcher",
    });
  });

  it("--skill with trailing text is a one-shot run carrying the skill", () => {
    expect(parseCliArgs(["--skill", "researcher", "do", "x"])).toEqual({
      command: "run",
      text: "do x",
      skill: "researcher",
    });
  });

  it("flags are extracted from any position around run text", () => {
    expect(parseCliArgs(["do", "--driver", "openai", "x"])).toEqual({
      command: "run",
      text: "do x",
      driver: "openai",
    });
    expect(parseCliArgs(["do", "x", "--skill", "coder"])).toEqual({
      command: "run",
      text: "do x",
      skill: "coder",
    });
  });

  it("a trailing flag without a value stays in the run text", () => {
    expect(parseCliArgs(["say", "--driver"])).toEqual({ command: "run", text: "say --driver" });
  });

  it("task subcommands win over flag extraction (existing shapes unchanged)", () => {
    expect(parseCliArgs(["task", "add", "t", "--driver", "openai"])).toMatchObject({
      command: "task-add",
      text: "t",
      driver: "openai",
    });
  });

  it("doctor parses to the doctor command", () => {
    expect(parseCliArgs(["doctor"])).toEqual({ command: "doctor" });
  });

  // --- service subcommand ----------------------------------------------------

  it("service install bare", () => {
    expect(parseCliArgs(["service", "install"])).toEqual({ command: "service-install" });
  });

  it("service install with --env-file and --cwd", () => {
    expect(parseCliArgs(["service", "install", "--env-file", "/p/.env", "--cwd", "/w"])).toEqual({
      command: "service-install",
      envFile: "/p/.env",
      cwd: "/w",
    });
  });

  it("service uninstall and status", () => {
    expect(parseCliArgs(["service", "uninstall"])).toEqual({ command: "service-uninstall" });
    expect(parseCliArgs(["service", "status"])).toEqual({ command: "service-status" });
  });

  it("service with unknown or missing action returns service-help", () => {
    expect(parseCliArgs(["service"])).toEqual({ command: "service-help" });
    expect(parseCliArgs(["service", "frobnicate"])).toEqual({ command: "service-help" });
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(overrides: Partial<CliDeps> = {}): CliDeps & { lines: string[] } {
  const lines: string[] = [];
  return {
    env: {
      TACHI_DAEMON_URL: "http://localhost:4000",
      GATEWAY_TOKEN: "test-token",
    },
    fetchImpl: fetch as typeof fetch,
    stdout: (line: string) => lines.push(line),
    lines,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// taskAdd
// ---------------------------------------------------------------------------
describe("taskAdd", () => {
  it("posts to /tasks and prints queued <id>", async () => {
    const body = { task_id: "tid-001", status: "queued" };
    const fetchImpl = async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status: 200 });

    const deps = makeDeps({ fetchImpl });
    await taskAdd(deps, "do something", {});
    expect(deps.lines).toEqual(["queued tid-001"]);
  });

  it("sends correct URL, headers, and body", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(JSON.stringify({ task_id: "x", status: "queued" }), { status: 200 });
    };

    const deps = makeDeps({ fetchImpl });
    await taskAdd(deps, "do something", { driver: "openai", maxAttempts: 2 });

    expect(capturedUrl).toBe("http://localhost:4000/tasks");
    expect(capturedInit?.method).toBe("POST");
    const headers = new Headers(capturedInit?.headers as Record<string, string>);
    expect(headers.get("Authorization")).toBe("Bearer test-token");
    expect(headers.get("Content-Type")).toBe("application/json");
    const sentBody = JSON.parse(capturedInit?.body as string);
    expect(sentBody).toMatchObject({ task: "do something", driver: "openai", maxAttempts: 2 });
  });

  it("strips trailing slash from TACHI_DAEMON_URL", async () => {
    let capturedUrl = "";
    const fetchImpl = async (url: string | URL | Request, _init?: RequestInit) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({ task_id: "x", status: "queued" }), { status: 200 });
    };
    const deps = makeDeps({
      fetchImpl,
      env: { TACHI_DAEMON_URL: "http://localhost:4000/", GATEWAY_TOKEN: "tok" },
    });
    await taskAdd(deps, "task", {});
    expect(capturedUrl).toBe("http://localhost:4000/tasks");
  });

  it("throws on missing TACHI_DAEMON_URL", async () => {
    const deps = makeDeps({ env: { GATEWAY_TOKEN: "tok" } });
    await expect(taskAdd(deps, "task", {})).rejects.toThrow(
      /task commands need a running daemon/,
    );
  });

  it("throws on missing GATEWAY_TOKEN", async () => {
    const deps = makeDeps({ env: { TACHI_DAEMON_URL: "http://localhost:4000" } });
    await expect(taskAdd(deps, "task", {})).rejects.toThrow(
      /task commands need a running daemon/,
    );
  });

  it("throws on non-2xx response", async () => {
    const fetchImpl = async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response("Internal Server Error", { status: 500 });
    const deps = makeDeps({ fetchImpl });
    await expect(taskAdd(deps, "task", {})).rejects.toThrow(/500/);
  });

  it("does not include driver/maxAttempts in body when not provided", async () => {
    let sentBody: Record<string, unknown> = {};
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      sentBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ task_id: "y", status: "queued" }), { status: 200 });
    };
    const deps = makeDeps({ fetchImpl });
    await taskAdd(deps, "plain task", {});
    expect(sentBody).not.toHaveProperty("driver");
    expect(sentBody).not.toHaveProperty("maxAttempts");
    expect(sentBody.task).toBe("plain task");
  });
});

// ---------------------------------------------------------------------------
// taskList
// ---------------------------------------------------------------------------
describe("taskList", () => {
  it("prints one line per task with correct format", async () => {
    const tasks = [
      {
        id: "id-1",
        status: "running",
        attempts: 1,
        maxAttempts: 3,
        driver: "openai",
        task: "A short task description that should appear",
      },
      {
        id: "id-2",
        status: "done",
        attempts: 2,
        maxAttempts: 3,
        driver: null,
        task: "Another task",
      },
    ];
    const fetchImpl = async () =>
      new Response(JSON.stringify({ tasks }), { status: 200 });
    const deps = makeDeps({ fetchImpl });
    await taskList(deps);
    expect(deps.lines).toHaveLength(2);
    expect(deps.lines[0]).toContain("id-1");
    expect(deps.lines[0]).toContain("running");
    expect(deps.lines[0]).toContain("attempt 1/3");
    expect(deps.lines[0]).toContain("openai");
    expect(deps.lines[0]).toContain("A short task description that should appear");
    expect(deps.lines[1]).toContain("id-2");
    expect(deps.lines[1]).toContain("done");
    expect(deps.lines[1]).toContain("default");
    expect(deps.lines[1]).toContain("Another task");
  });

  it("truncates task text to 60 chars", async () => {
    const longTask = "x".repeat(80);
    const tasks = [
      { id: "id-3", status: "queued", attempts: 0, maxAttempts: 1, driver: "d", task: longTask },
    ];
    const fetchImpl = async () =>
      new Response(JSON.stringify({ tasks }), { status: 200 });
    const deps = makeDeps({ fetchImpl });
    await taskList(deps);
    // The line should contain only the first 60 chars, not the full 80
    expect(deps.lines[0]).toContain("x".repeat(60));
    expect(deps.lines[0]).not.toContain("x".repeat(61));
  });

  it("throws on missing env", async () => {
    const deps = makeDeps({ env: {} });
    await expect(taskList(deps)).rejects.toThrow(/task commands need a running daemon/);
  });
});

// ---------------------------------------------------------------------------
// taskShow
// ---------------------------------------------------------------------------
describe("taskShow", () => {
  it("pretty-prints the record JSON", async () => {
    const record = { id: "id-1", task: "hello", status: "done", attempts: 1, maxAttempts: 3 };
    const fetchImpl = async () =>
      new Response(JSON.stringify(record), { status: 200 });
    const deps = makeDeps({ fetchImpl });
    await taskShow(deps, "id-1");
    expect(deps.lines).toHaveLength(1);
    expect(deps.lines[0]).toBe(JSON.stringify(record, null, 2));
  });

  it("hits the correct URL", async () => {
    let capturedUrl = "";
    const fetchImpl = async (url: string | URL | Request) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({}), { status: 200 });
    };
    const deps = makeDeps({ fetchImpl });
    await taskShow(deps, "abc-999");
    expect(capturedUrl).toBe("http://localhost:4000/tasks/abc-999");
  });
});

// ---------------------------------------------------------------------------
// runsLog
// ---------------------------------------------------------------------------
describe("runsLog", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `tachi-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function writeLog(runId: string, events: object[]) {
    const lines = events
      .map((e, i) => JSON.stringify({ seq: i + 1, ts: 1700000000000 + i * 1000, event: e }))
      .join("\n") + "\n";
    await writeFile(join(tmpDir, `${runId}.jsonl`), lines, "utf8");
  }

  it("prints one line per event for assistant with content", async () => {
    await writeLog("run-1", [
      { type: "assistant", content: "Here is my answer about things", toolCalls: [] },
    ]);
    const deps = makeDeps({ env: { TACHI_RUN_LOG_DIR: tmpDir } });
    await runsLog(deps, "run-1");
    expect(deps.lines).toHaveLength(1);
    expect(deps.lines[0]).toContain("assistant");
    expect(deps.lines[0]).toContain("Here is my answer about things");
  });

  it("prints tool-call names for assistant with toolCalls", async () => {
    await writeLog("run-2", [
      {
        type: "assistant",
        content: "",
        toolCalls: [
          { name: "dokoro_recall", arguments: {} },
          { name: "dokoro_log", arguments: {} },
        ],
      },
    ]);
    const deps = makeDeps({ env: { TACHI_RUN_LOG_DIR: tmpDir } });
    await runsLog(deps, "run-2");
    expect(deps.lines[0]).toContain("dokoro_recall");
    expect(deps.lines[0]).toContain("dokoro_log");
  });

  it("prints tool-result name and content", async () => {
    await writeLog("run-3", [
      { type: "tool-result", name: "search_web", result: "some result text" },
    ]);
    const deps = makeDeps({ env: { TACHI_RUN_LOG_DIR: tmpDir } });
    await runsLog(deps, "run-3");
    expect(deps.lines[0]).toContain("tool-result");
    expect(deps.lines[0]).toContain("search_web");
    expect(deps.lines[0]).toContain("some result text");
  });

  it("prints final haltedBy and answer excerpt", async () => {
    await writeLog("run-4", [
      { type: "final", answer: "The final answer here", haltedBy: "final-answer" },
    ]);
    const deps = makeDeps({ env: { TACHI_RUN_LOG_DIR: tmpDir } });
    await runsLog(deps, "run-4");
    expect(deps.lines[0]).toContain("final");
    expect(deps.lines[0]).toContain("final-answer");
    expect(deps.lines[0]).toContain("The final answer here");
  });

  it("truncates long assistant content to 80 chars", async () => {
    const longContent = "y".repeat(100);
    await writeLog("run-5", [
      { type: "assistant", content: longContent, toolCalls: [] },
    ]);
    const deps = makeDeps({ env: { TACHI_RUN_LOG_DIR: tmpDir } });
    await runsLog(deps, "run-5");
    expect(deps.lines[0]).toContain("y".repeat(80));
    expect(deps.lines[0]).not.toContain("y".repeat(81));
  });

  it("prints no-events message for missing log", async () => {
    const deps = makeDeps({ env: { TACHI_RUN_LOG_DIR: tmpDir } });
    await runsLog(deps, "run-nonexistent");
    expect(deps.lines).toHaveLength(1);
    expect(deps.lines[0]).toContain("no events for run-nonexistent");
  });

  it("prints no-events message for empty log file", async () => {
    await writeFile(join(tmpDir, "run-empty.jsonl"), "", "utf8");
    const deps = makeDeps({ env: { TACHI_RUN_LOG_DIR: tmpDir } });
    await runsLog(deps, "run-empty");
    expect(deps.lines).toHaveLength(1);
    expect(deps.lines[0]).toContain("no events for run-empty");
  });

  it("explains the LOCAL log dir when empty and TACHI_DAEMON_URL is set (remote daemon)", async () => {
    const deps = makeDeps({
      env: { TACHI_RUN_LOG_DIR: tmpDir, TACHI_DAEMON_URL: "http://remote:4000" },
    });
    await runsLog(deps, "run-remote");
    expect(deps.lines).toHaveLength(1);
    expect(deps.lines[0]).toContain("no events for run-remote");
    expect(deps.lines[0]).toContain(`LOCAL ${tmpDir}`);
    expect(deps.lines[0]).toContain("TACHI_DAEMON_URL is set");
    expect(deps.lines[0]).toContain("TACHI_RUN_LOG_DIR");
  });

  it("keeps the plain no-events message when TACHI_DAEMON_URL is unset", async () => {
    const deps = makeDeps({ env: { TACHI_RUN_LOG_DIR: tmpDir } });
    await runsLog(deps, "run-local");
    expect(deps.lines).toHaveLength(1);
    expect(deps.lines[0]).toBe("no events for run-local");
  });

  it("includes seq and ISO timestamp in each line", async () => {
    await writeLog("run-6", [
      { type: "assistant", content: "hello", toolCalls: [] },
    ]);
    const deps = makeDeps({ env: { TACHI_RUN_LOG_DIR: tmpDir } });
    await runsLog(deps, "run-6");
    // seq
    expect(deps.lines[0]).toMatch(/\b1\b/);
    // ISO timestamp from ts=1700000000000
    expect(deps.lines[0]).toContain(new Date(1700000000000).toISOString());
  });
});
