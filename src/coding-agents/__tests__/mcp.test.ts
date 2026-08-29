import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { registerCodingAgentTool, runCodingAgentHandler } from "../mcp.js";
import type { CodingAgentResult } from "../runner.js";

describe("run_coding_agent MCP handler", () => {
  const coordinationTools = [
    "dokoro_dokoro_presence_ping",
    "dokoro_dokoro_handoff_write",
  ].map((name) => ({ name, description: "", parameters: {} }));

  it("refuses nested spawns before acquiring any resources", async () => {
    process.env.TACHI_CODING_DEPTH = "1";
    try {
      const callInternal = vi.fn(async () => "ok");
      const runtime = {
        host: { internalTools: () => coordinationTools, callInternal },
        memory: { log: vi.fn(async () => undefined) },
      } as any;
      const runner = vi.fn();
      const out = await runCodingAgentHandler(runtime, { agent: "codex", task: "t" }, runner as any);
      expect(out.isError).toBe(true);
      expect(out.content[0].text).toMatch(/recursion guard/i);
      expect(runner).not.toHaveBeenCalled();
      expect(callInternal).not.toHaveBeenCalled(); // no lease, no handoff
    } finally {
      delete process.env.TACHI_CODING_DEPTH;
    }
  });

  it("returns the worker result synchronously and persists a Dokoro report", async () => {
    const callInternal = vi.fn(async () => "ok");
    const log = vi.fn(async () => undefined);
    const runtime = {
      host: { internalTools: () => coordinationTools, callInternal },
      memory: { log },
    } as any;
    const runner = vi.fn(async (): Promise<CodingAgentResult> => ({
      agent: "codex",
      mode: "review",
      cwd: process.cwd(),
      isolated: false,
      answer: "No issues found",
      trace: [{ kind: "reasoning", message: "Checked the public API." }],
      stdout: "",
      stderr: "",
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
    }));

    const out = await runCodingAgentHandler(runtime, { agent: "codex", task: "review", cwd: process.cwd() }, runner);
    expect(out.isError).toBeFalsy();
    expect(out.content[0].text).toContain("No issues found");
    expect(out.content[0].text).toContain("### Agent trace");
    expect(out.content[0].text).toContain("Checked the public API.");
    expect(out.content[0].text).toContain("handoff: Dokoro");
    expect(log).toHaveBeenCalledOnce();
    expect(callInternal).toHaveBeenCalledWith(
      "dokoro_dokoro_handoff_write",
      expect.objectContaining({ to_agent: "claude-code" }),
      undefined,
    );
  });

  it("forwards live progress and cancellation to the coding runner", async () => {
    const onProgress = vi.fn(async () => undefined);
    const controller = new AbortController();
    const runtime = {
      host: { internalTools: () => [], callInternal: vi.fn() },
      memory: undefined,
    } as any;
    const runner = vi.fn(async (args) => {
      await args.onProgress?.({ kind: "status", message: "working" });
      return {
        agent: "openrouter",
        provider: "openrouter",
        model: "qwen/qwen3-coder",
        mode: "review",
        cwd: process.cwd(),
        isolated: true,
        answer: "done",
        stdout: "done",
        stderr: "",
        exitCode: 0,
        signal: null,
        timedOut: false,
        aborted: false,
      } as const;
    });

    await runCodingAgentHandler(
      runtime,
      { agent: "openrouter", model: "qwen/qwen3-coder", task: "review", reportToDokoro: false },
      runner,
      { signal: controller.signal, onProgress },
    );

    expect(runner).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal, onProgress }));
    expect(onProgress).toHaveBeenCalledWith({ kind: "status", message: "working" });
  });

  const writeResult = async (): Promise<CodingAgentResult> => ({
    agent: "codex",
    mode: "write",
    cwd: process.cwd(),
    isolated: false,
    answer: "done",
    stdout: "",
    stderr: "",
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
  });
  const bareRuntime = () => ({ host: { internalTools: () => [], callInternal: vi.fn(async () => "") }, memory: undefined } as any);

  it("rejects write mode unless TACHI_CODING_ALLOW_WRITE is set", async () => {
    delete process.env.TACHI_CODING_ALLOW_WRITE;
    const out = await runCodingAgentHandler(bareRuntime(), { agent: "codex", task: "t", mode: "write" }, writeResult);
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toMatch(/TACHI_CODING_ALLOW_WRITE/);
  });

  it("allows write mode when the env grant is present", async () => {
    process.env.TACHI_CODING_ALLOW_WRITE = "1";
    try {
      const out = await runCodingAgentHandler(
        bareRuntime(),
        { agent: "codex", task: "t", mode: "write", reportToDokoro: false },
        writeResult,
      );
      expect(out.isError).toBeFalsy();
    } finally {
      delete process.env.TACHI_CODING_ALLOW_WRITE;
    }
  });

  it("reports the OpenRouter harness in the header and the Dokoro handoff", async () => {
    const callInternal = vi.fn(async () => "ok");
    const runtime = {
      host: { internalTools: () => coordinationTools, callInternal },
      memory: { log: vi.fn(async () => undefined) },
    } as any;
    const runner = vi.fn(async (): Promise<CodingAgentResult> => ({
      agent: "openrouter",
      provider: "openrouter",
      model: "z-ai/glm-5.3-flash",
      harness: "codex",
      mode: "review",
      cwd: process.cwd(),
      isolated: false,
      answer: "review complete",
      stdout: "",
      stderr: "",
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
    }));

    const out = await runCodingAgentHandler(
      runtime,
      { agent: "openrouter", model: "z-ai/glm-5.3-flash", task: "review", cwd: process.cwd(), targetAgent: "fable" },
      runner,
    );

    expect(out.isError).toBeFalsy();
    // Identity string is unchanged; the harness is an ADDITIONAL header field.
    expect(out.content[0].text).toContain("agent: openrouter/openrouter/z-ai/glm-5.3-flash");
    expect(out.content[0].text).toContain("harness: codex");
    expect(callInternal).toHaveBeenCalledWith(
      "dokoro_dokoro_handoff_write",
      expect.objectContaining({
        to_agent: "fable",
        summary: expect.stringContaining("Harness: codex"),
      }),
      undefined,
    );
  });

  it("omits the harness field for agents that have none", async () => {
    const out = await runCodingAgentHandler(
      bareRuntime(),
      { agent: "codex", task: "t", reportToDokoro: false },
      async () => ({ ...(await writeResult()), mode: "review" }),
    );
    expect(out.content[0].text).not.toMatch(/harness/i);
  });

  it("keeps the public tool contract: six agents, no harness input", () => {
    const schemas: Record<string, unknown>[] = [];
    const server = {
      registerTool: (_name: string, config: { inputSchema: Record<string, unknown> }) => {
        schemas.push(config.inputSchema);
      },
    } as any;
    registerCodingAgentTool(server, { host: {}, memory: undefined } as any);

    expect(schemas).toHaveLength(1);
    const schema = schemas[0];
    expect(Object.keys(schema)).not.toContain("harness");
    expect((schema.agent as z.ZodEnum<[string, ...string[]]>).options)
      .toEqual(["codex", "grok", "hermes", "openrouter", "gemini", "claude"]);
  });

  it("prints an enter-session command for agents whose CLI can resume the worker session", async () => {
    const withSession = (agent: CodingAgentResult["agent"]) => async (): Promise<CodingAgentResult> => ({
      ...(await writeResult()),
      agent,
      mode: "review",
      sessionId: "01a04e0e-18d3-7d02-94bb-4d67cd6febb0",
    });
    const grokOut = await runCodingAgentHandler(
      bareRuntime(),
      { agent: "grok", task: "t", reportToDokoro: false },
      withSession("grok"),
    );
    expect(grokOut.content[0].text).toContain("enter: grok -r 01a04e0e-18d3-7d02-94bb-4d67cd6febb0");
    const codexOut = await runCodingAgentHandler(
      bareRuntime(),
      { agent: "codex", task: "t", reportToDokoro: false },
      withSession("codex"),
    );
    expect(codexOut.content[0].text).toContain("enter: codex resume 01a04e0e-18d3-7d02-94bb-4d67cd6febb0");
    const claudeOut = await runCodingAgentHandler(
      bareRuntime(),
      { agent: "claude", task: "t", reportToDokoro: false },
      withSession("claude"),
    );
    expect(claudeOut.content[0].text).toContain("enter: claude -r 01a04e0e-18d3-7d02-94bb-4d67cd6febb0");
  });

  it("omits the enter-session hint without a session id or for CLIs with no resume", async () => {
    const noSession = await runCodingAgentHandler(
      bareRuntime(),
      { agent: "codex", task: "t", reportToDokoro: false },
      async () => ({ ...(await writeResult()), mode: "review" }),
    );
    expect(noSession.content[0].text).not.toContain("enter:");
    const gemini = await runCodingAgentHandler(
      bareRuntime(),
      { agent: "gemini", task: "t", reportToDokoro: false },
      async (): Promise<CodingAgentResult> => ({
        ...(await writeResult()),
        agent: "gemini",
        mode: "review",
        sessionId: "abc",
      }),
    );
    expect(gemini.content[0].text).not.toContain("enter:");
  });

  it("flags unconfirmed leases when plannedFiles were requested but not claimed", async () => {
    const reviewResult = async (): Promise<CodingAgentResult> => ({ ...(await writeResult()), mode: "review" });
    const out = await runCodingAgentHandler(
      bareRuntime(),
      { agent: "codex", task: "t", mode: "review", plannedFiles: ["a.ts"], reportToDokoro: false },
      reviewResult,
    );
    expect(out.content[0].text).toMatch(/leases unconfirmed/i);
  });
});
