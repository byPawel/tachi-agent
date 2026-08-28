import { describe, expect, it, vi } from "vitest";
import { beginCodingCoordination, finishCodingCoordination, type CoordinationHost } from "../coordination.js";

const tools = [
  "dokoro_dokoro_presence_ping",
  "dokoro_dokoro_file_claim",
  "dokoro_dokoro_file_release",
  "dokoro_dokoro_handoff_write",
].map((name) => ({ name, description: "", parameters: {} }));

function host(outputs: Record<string, string> = {}) {
  const callInternal = vi.fn(async (name: string) => outputs[name] ?? "ok");
  return { internalTools: () => tools, callInternal } as CoordinationHost & { callInternal: typeof callInternal };
}

const context = {
  agentId: "tachi-codex-1",
  sessionId: "session-1",
  task: "Implement task 2",
  cwd: process.cwd(),
  files: ["src/a.ts"],
};

describe("coding-agent Dokoro coordination", () => {
  it("announces presence and leases the plan files", async () => {
    const h = host();
    await expect(beginCodingCoordination(h, context)).resolves.toEqual({ claimed: true });
    expect(h.callInternal).toHaveBeenCalledWith(
      "dokoro_dokoro_file_claim",
      expect.objectContaining({ paths: ["src/a.ts"], agent_id: "tachi-codex-1", root: process.cwd() }),
      undefined,
    );
  });

  it("stops before launch when Dokoro reports a claim conflict", async () => {
    const h = host({ "dokoro_dokoro_file_claim": "CONFLICT — NOTHING was claimed" });
    await expect(beginCodingCoordination(h, context)).rejects.toThrow(/file-claim conflict/i);
  });

  it("writes a directed handoff, releases files and marks the worker idle", async () => {
    const h = host();
    await finishCodingCoordination(h, context, { summary: "done", targetAgent: "claude-code" }, true);
    expect(h.callInternal).toHaveBeenCalledWith(
      "dokoro_dokoro_handoff_write",
      expect.objectContaining({ from_agent: "tachi-codex-1", to_agent: "claude-code", summary: "done" }),
      undefined,
    );
    expect(h.callInternal).toHaveBeenCalledWith(
      "dokoro_dokoro_file_release",
      expect.objectContaining({ paths: ["src/a.ts"], agent_id: "tachi-codex-1" }),
      undefined,
    );
  });
});
