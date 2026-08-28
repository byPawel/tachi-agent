import { describe, it, expect, afterEach } from "vitest";
import { runAgentHandler, resolveRunTimeoutMs, resolveSkillArgs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS } from "../mcp-server.js";
import type { RunResult } from "../../types.js";
import type { Skill } from "../../skills.js";

/** Fake runtime whose orchestrator returns a scripted RunResult (or throws). */
function fakeRuntime(result: RunResult | Error, capture?: (opts: unknown, driver?: string) => void) {
  return {
    orchestrator(opts: unknown, driver?: string) {
      capture?.(opts, driver);
      return {
        run: async (_task: string) => {
          if (result instanceof Error) throw result;
          return result;
        },
      };
    },
  } as any;
}

const ok: RunResult = { answer: "VERDICT: ship it", iterations: 2, toolCalls: [{ name: "tachibot_jury", args: {}, result: "yes" }], haltedBy: "final-answer", costUsd: 0.05 };

describe("run_agent MCP handler", () => {
  it("formats a successful run as a text result with a header", async () => {
    const res = await runAgentHandler(fakeRuntime(ok), { task: "verify ADRs" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].type).toBe("text");
    expect(res.content[0].text).toContain("VERDICT: ship it");
    expect(res.content[0].text).toContain("halted: final-answer");
    expect(res.content[0].text).toContain("2 steps");
  });

  it("passes maxIterations + a timeout + an AbortSignal through to the orchestrator", async () => {
    let seen: any;
    await runAgentHandler(fakeRuntime(ok, (o) => (seen = o)), { task: "x", maxIterations: 5 });
    expect(seen.maxIterations).toBe(5);
    expect(seen.timeoutMs).toBeGreaterThan(0);
    expect(seen.signal).toBeInstanceOf(AbortSignal);
  });

  it("defaults maxIterations when not provided", async () => {
    let seen: any;
    await runAgentHandler(fakeRuntime(ok, (o) => (seen = o)), { task: "x" });
    expect(seen.maxIterations).toBe(8);
  });

  it("returns isError (not a throw) when the run fails", async () => {
    const res = await runAgentHandler(fakeRuntime(new Error("Ollama unreachable")), { task: "x" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Ollama unreachable");
  });

  it("per-call timeoutMs overrides the default and reaches the orchestrator", async () => {
    let seen: any;
    await runAgentHandler(fakeRuntime(ok, (o) => (seen = o)), { task: "x", timeoutMs: 300_000 });
    expect(seen.timeoutMs).toBe(300_000);
  });

  it("falls back to defaults.timeoutMs when no per-call timeoutMs is given", async () => {
    let seen: any;
    await runAgentHandler(fakeRuntime(ok, (o) => (seen = o)), { task: "x" }, { maxIterations: 8, timeoutMs: 240_000 });
    expect(seen.timeoutMs).toBe(240_000);
  });

  it("passes driver / systemPrompt / allowTools through to the orchestrator", async () => {
    let seenOpts: any;
    let seenDriver: string | undefined;
    await runAgentHandler(
      fakeRuntime(ok, (o, d) => { seenOpts = o; seenDriver = d; }),
      { task: "x", driver: "openrouter", systemPrompt: "Be terse.", allowTools: ["tachibot_jury"] },
    );
    expect(seenDriver).toBe("openrouter");
    expect(seenOpts.systemPrompt).toBe("Be terse.");
    expect(seenOpts.allowTools).toEqual(["tachibot_jury"]);
  });

  it("omits systemPrompt/allowTools from the options when not provided", async () => {
    let seen: any;
    await runAgentHandler(fakeRuntime(ok, (o) => (seen = o)), { task: "x" });
    expect("systemPrompt" in seen).toBe(false);
    expect("allowTools" in seen).toBe(false);
  });

  it("returns isError when the driver registry rejects an unknown driver", async () => {
    const runtime = {
      orchestrator() { throw new Error('unknown driver "nope"'); },
    } as any;
    const res = await runAgentHandler(runtime, { task: "x", driver: "nope" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('unknown driver "nope"');
  });
});

describe("resolveSkillArgs", () => {
  const RESEARCHER: Skill = {
    name: "researcher",
    description: "grounded research",
    prompt: "Always search before answering.",
    tools: ["tachibot_grok_search", "tachibot_perplexity_ask"],
    driver: "openai",
  };

  it("returns args unchanged when no skill is requested", () => {
    const args = { task: "x", driver: "ollama" };
    expect(resolveSkillArgs(args, [RESEARCHER])).toBe(args);
  });

  it("merges the skill's prompt, tools and driver into the args", () => {
    const out = resolveSkillArgs({ task: "x", skill: "researcher" }, [RESEARCHER]);
    expect(out.driver).toBe("openai");
    expect(out.systemPrompt).toBe("Always search before answering.");
    expect(out.allowTools).toEqual(["tachibot_grok_search", "tachibot_perplexity_ask"]);
  });

  it("explicit driver wins over the skill's driver; explicit systemPrompt is appended after the skill prompt", () => {
    const out = resolveSkillArgs(
      { task: "x", skill: "researcher", driver: "openrouter", systemPrompt: "Answer in Polish." },
      [RESEARCHER],
    );
    expect(out.driver).toBe("openrouter");
    expect(out.systemPrompt).toBe("Always search before answering.\n\nAnswer in Polish.");
  });

  it("throws actionably (with available names) on an unknown skill", () => {
    expect(() => resolveSkillArgs({ task: "x", skill: "ghost" }, [RESEARCHER]))
      .toThrow(/unknown skill "ghost".*researcher/);
  });
});

describe("resolveRunTimeoutMs", () => {
  afterEach(() => { delete process.env.TACHI_RUN_TIMEOUT_MS; });

  it("returns the built-in default when the env var is unset", () => {
    delete process.env.TACHI_RUN_TIMEOUT_MS;
    expect(resolveRunTimeoutMs()).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("returns the env value when it is a positive number", () => {
    process.env.TACHI_RUN_TIMEOUT_MS = "600000";
    expect(resolveRunTimeoutMs()).toBe(600_000);
  });

  it("fails soft to the default on garbage or non-positive values", () => {
    process.env.TACHI_RUN_TIMEOUT_MS = "banana";
    expect(resolveRunTimeoutMs()).toBe(DEFAULT_TIMEOUT_MS);
    process.env.TACHI_RUN_TIMEOUT_MS = "-5";
    expect(resolveRunTimeoutMs()).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("clamps absurd values to MAX_TIMEOUT_MS", () => {
    process.env.TACHI_RUN_TIMEOUT_MS = "999999999999";
    expect(resolveRunTimeoutMs()).toBe(MAX_TIMEOUT_MS);
  });

  it("floors fractional values to an integer (zod schema requires int)", () => {
    process.env.TACHI_RUN_TIMEOUT_MS = "1500.7";
    expect(resolveRunTimeoutMs()).toBe(1500);
  });
});
