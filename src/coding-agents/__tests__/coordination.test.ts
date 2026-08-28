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

function hostReturning(output: string) {
  return {
    internalTools: () => [{ name: "dokoro__dokoro_file_claim", description: "", parameters: {} }],
    callInternal: async () => output,
  } as CoordinationHost;
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
    const h = host({
      "dokoro_dokoro_file_claim": '{"claimed":true,"report":[{"path":"src/a.ts","status":"claimed"}]}',
    });
    await expect(beginCodingCoordination(h, context)).resolves.toEqual({ claimed: true, conflict: false });
    expect(h.callInternal).toHaveBeenCalledWith(
      "dokoro_dokoro_file_claim",
      expect.objectContaining({ paths: ["src/a.ts"], agent_id: "tachi-codex-1", root: process.cwd() }),
      undefined,
    );
  });

  it("stops before launch when Dokoro reports a claim conflict", async () => {
    const h = host({
      "dokoro_dokoro_file_claim":
        'CONFLICT — NOTHING was claimed\n{"claimed":false,"report":[{"path":"src/a.ts","status":"conflict"}]}',
    });
    await expect(beginCodingCoordination(h, context)).rejects.toThrow(/file-claim conflict/i);
  });

  it("does NOT treat a dokoro error string as a granted claim (fail closed)", async () => {
    const h = hostReturning("file_claim rejected — NOTHING was claimed. Invalid path(s):\n- ../x");
    const r = await beginCodingCoordination(h, {
      agentId: "a", sessionId: "s", task: "t", cwd: "/repo", files: ["a.ts"],
    });
    expect(r.claimed).toBe(false);
  });

  it("treats a structured granted claim as claimed", async () => {
    const h = hostReturning('ok\n{"claimed":true,"report":[{"path":"a.ts","status":"claimed"}]}');
    const r = await beginCodingCoordination(h, {
      agentId: "a", sessionId: "s", task: "t", cwd: "/repo", files: ["a.ts"],
    });
    expect(r.claimed).toBe(true);
  });

  it("throws on a structured conflict", async () => {
    const h = hostReturning('CONFLICT — NOTHING was claimed\n{"claimed":false,"report":[{"path":"a.ts","status":"conflict"}]}');
    await expect(beginCodingCoordination(h, {
      agentId: "a", sessionId: "s", task: "t", cwd: "/repo", files: ["a.ts"],
    })).rejects.toThrow(/conflict/i);
  });

  it("derives the lease TTL from the run timeout plus a margin", async () => {
    const h = host({ "dokoro_dokoro_file_claim": '{"claimed":true,"report":[]}' });
    await beginCodingCoordination(h, { ...context, timeoutMs: 120_000 });
    expect(h.callInternal).toHaveBeenCalledWith(
      "dokoro_dokoro_file_claim",
      expect.objectContaining({ ttl_seconds: 420 }),
      undefined,
    );
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
