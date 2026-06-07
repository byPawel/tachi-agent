// src/swarm/__tests__/swarm.test.ts
import { describe, it, expect } from "vitest";
import { runSwarm, SYNTHESIZER_ROLE } from "../swarm.js";
import type { SwarmRole, SwarmAgent } from "../types.js";
import type { RunResult } from "../../types.js";

const result = (answer: string): RunResult => ({ answer, iterations: 1, toolCalls: [], haltedBy: "final-answer", costUsd: 0 });

function fakeAgent(answer: string, spy?: (t: string) => void): SwarmAgent {
  return { run: async (task) => { spy?.(task); return result(`${answer}::${task.slice(0, 8)}`); } };
}

describe("runSwarm", () => {
  it("runs every role then synthesizes, returning the synthesizer's answer + member answers", async () => {
    const roles: SwarmRole[] = [
      { name: "a", systemPrompt: "A" },
      { name: "b", systemPrompt: "B" },
    ];
    const seen: string[] = [];
    const makeAgent = (role: SwarmRole): SwarmAgent =>
      role.name === SYNTHESIZER_ROLE.name ? fakeAgent("SYNTH", (t) => seen.push(t)) : fakeAgent(role.name);
    const out = await runSwarm("the task", roles, { makeAgent });

    expect(out.members.map((m) => m.role)).toEqual(["a", "b"]);
    expect(out.members.map((m) => m.answer)).toEqual(["a::the task", "b::the task"]);
    expect(out.answer).toContain("SYNTH");
    // synthesizer saw a prompt built from both member answers
    expect(seen[0]).toContain("a::the task");
    expect(seen[0]).toContain("b::the task");
  });

  it("tolerates a member that throws — records empty answer, still synthesizes", async () => {
    const roles: SwarmRole[] = [{ name: "ok", systemPrompt: "" }, { name: "bad", systemPrompt: "" }];
    const makeAgent = (role: SwarmRole): SwarmAgent => {
      if (role.name === SYNTHESIZER_ROLE.name) return fakeAgent("SYNTH");
      if (role.name === "bad") return { run: async () => { throw new Error("boom"); } };
      return fakeAgent("ok");
    };
    const out = await runSwarm("t", roles, { makeAgent });
    expect(out.members.find((m) => m.role === "bad")).toMatchObject({ answer: "", haltedBy: "aborted" });
    expect(out.answer).toContain("SYNTH");
  });

  it("bounds parallelism to opts.concurrency", async () => {
    let active = 0;
    let peak = 0;
    const roles: SwarmRole[] = ["a", "b", "c", "d"].map((name) => ({ name, systemPrompt: "" }));
    const makeAgent = (role: SwarmRole): SwarmAgent =>
      role.name === SYNTHESIZER_ROLE.name
        ? fakeAgent("SYNTH")
        : {
            run: async () => {
              active++;
              peak = Math.max(peak, active);
              await new Promise((r) => setTimeout(r, 5));
              active--;
              return result(role.name);
            },
          };
    const out = await runSwarm("t", roles, { makeAgent }, { concurrency: 2 });
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThanOrEqual(2);
    expect(out.members.map((m) => m.role)).toEqual(["a", "b", "c", "d"]); // order preserved despite pooling
  });

  it("calls onMember once per settled member, including failures", async () => {
    const roles: SwarmRole[] = [{ name: "ok", systemPrompt: "" }, { name: "bad", systemPrompt: "" }];
    const makeAgent = (role: SwarmRole): SwarmAgent => {
      if (role.name === SYNTHESIZER_ROLE.name) return fakeAgent("SYNTH");
      if (role.name === "bad") return { run: async () => { throw new Error("boom"); } };
      return fakeAgent("ok");
    };
    const seen: string[] = [];
    await runSwarm("t", roles, { makeAgent }, { onMember: (m) => seen.push(m.role) });
    expect(seen.sort()).toEqual(["bad", "ok"]);
  });

  it("warns (does not throw) below quorum and when a critical role is empty", async () => {
    const roles: SwarmRole[] = [
      { name: "impl", systemPrompt: "" },
      { name: "critic", systemPrompt: "", critical: true },
    ];
    const makeAgent = (role: SwarmRole): SwarmAgent => {
      if (role.name === SYNTHESIZER_ROLE.name) return fakeAgent("SYNTH");
      if (role.name === "critic") return { run: async () => { throw new Error("boom"); } };
      return fakeAgent("impl");
    };
    const out = await runSwarm("t", roles, { makeAgent }); // minQuorum default 2; only 1 answers
    expect(out.warnings).toBeDefined();
    expect(out.warnings!.join(" ")).toMatch(/quorum/i);
    expect(out.warnings!.join(" ")).toMatch(/critical/i);
    expect(out.answer).toContain("SYNTH");
  });

  it("no warnings when quorum met and no critical gaps", async () => {
    const roles: SwarmRole[] = [{ name: "a", systemPrompt: "" }, { name: "b", systemPrompt: "" }];
    const makeAgent = (role: SwarmRole): SwarmAgent =>
      role.name === SYNTHESIZER_ROLE.name ? fakeAgent("SYNTH") : fakeAgent(role.name);
    const out = await runSwarm("t", roles, { makeAgent });
    expect(out.warnings).toBeUndefined();
  });

  it("does not warn for a single-role swarm whose only role answers (minQuorum capped to role count)", async () => {
    const roles: SwarmRole[] = [{ name: "solo", systemPrompt: "" }];
    const makeAgent = (role: SwarmRole): SwarmAgent =>
      role.name === SYNTHESIZER_ROLE.name ? fakeAgent("SYNTH") : fakeAgent(role.name);
    const out = await runSwarm("t", roles, { makeAgent });
    expect(out.warnings).toBeUndefined();
  });

  it("caps an over-large minQuorum to the number of roles", async () => {
    const roles: SwarmRole[] = [{ name: "a", systemPrompt: "" }, { name: "b", systemPrompt: "" }];
    const makeAgent = (role: SwarmRole): SwarmAgent =>
      role.name === SYNTHESIZER_ROLE.name ? fakeAgent("SYNTH") : fakeAgent(role.name);
    const out = await runSwarm("t", roles, { makeAgent }, { minQuorum: 5 }); // 5 > 2 roles, both answer → no warning
    expect(out.warnings).toBeUndefined();
  });

  it("does not start members once the signal is aborted; records the rest as aborted, order preserved", async () => {
    const roles: SwarmRole[] = ["a", "b", "c"].map((name) => ({ name, systemPrompt: "" }));
    const started: string[] = [];
    const makeAgent = (role: SwarmRole): SwarmAgent =>
      role.name === SYNTHESIZER_ROLE.name
        ? fakeAgent("SYNTH")
        : { run: async () => { started.push(role.name); return result(role.name); } };
    const ac = new AbortController();
    ac.abort();
    const out = await runSwarm("t", roles, { makeAgent }, { signal: ac.signal });
    expect(started).toEqual([]); // no member agent was started after abort
    expect(out.members.map((m) => m.role)).toEqual(["a", "b", "c"]); // fully populated, order preserved
    expect(out.members.every((m) => m.haltedBy === "aborted" && m.answer === "")).toBe(true);
  });

  it("tolerates a synthesizer failure — returns members + a warning instead of throwing", async () => {
    const roles: SwarmRole[] = [{ name: "a", systemPrompt: "" }, { name: "b", systemPrompt: "" }];
    const makeAgent = (role: SwarmRole): SwarmAgent =>
      role.name === SYNTHESIZER_ROLE.name
        ? { run: async () => { throw new Error("synth boom"); } }
        : fakeAgent(role.name);
    const out = await runSwarm("t", roles, { makeAgent });
    expect(out.answer).toBe("");
    expect(out.members.map((m) => m.role)).toEqual(["a", "b"]); // member perspectives still returned
    expect(out.warnings!.join(" ")).toMatch(/synth/i);
  });
});
