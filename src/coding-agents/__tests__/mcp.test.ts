import { describe, expect, it, vi } from "vitest";
import { runCodingAgentHandler } from "../mcp.js";

describe("run_coding_agent MCP handler", () => {
  const coordinationTools = [
    "dokoro_dokoro_presence_ping",
    "dokoro_dokoro_handoff_write",
  ].map((name) => ({ name, description: "", parameters: {} }));

  it("returns the worker result synchronously and persists a Dokoro report", async () => {
    const callInternal = vi.fn(async () => "ok");
    const log = vi.fn(async () => undefined);
    const runtime = {
      host: { internalTools: () => coordinationTools, callInternal },
      memory: { log },
    } as any;
    const runner = vi.fn(async () => ({
      agent: "codex",
      mode: "review",
      cwd: process.cwd(),
      isolated: false,
      answer: "No issues found",
      stdout: "",
      stderr: "",
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
    } as const));

    const out = await runCodingAgentHandler(runtime, { agent: "codex", task: "review", cwd: process.cwd() }, runner);
    expect(out.isError).toBeFalsy();
    expect(out.content[0].text).toContain("No issues found");
    expect(out.content[0].text).toContain("handoff: Dokoro");
    expect(log).toHaveBeenCalledOnce();
    expect(callInternal).toHaveBeenCalledWith(
      "dokoro_dokoro_handoff_write",
      expect.objectContaining({ to_agent: "claude-code" }),
      undefined,
    );
  });
});
