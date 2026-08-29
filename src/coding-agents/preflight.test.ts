// src/coding-agents/preflight.test.ts
import { describe, it, expect } from "vitest";
import { preflightCodingAgent, type PreflightDeps } from "./preflight.js";

function deps(over: Partial<PreflightDeps> = {}): PreflightDeps {
  return {
    env: {},
    hasBinary: async () => true,
    fileExists: async () => false,
    home: "/home/dev",
    ...over,
  };
}

describe("preflightCodingAgent", () => {
  it("fails closed when the CLI binary is missing", async () => {
    const r = await preflightCodingAgent("codex", "codex", deps({ hasBinary: async () => false }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not found on PATH/i);
  });

  it("codex passes with CODEX_API_KEY", async () => {
    const r = await preflightCodingAgent("codex", "codex", deps({ env: { CODEX_API_KEY: "sk" } }));
    expect(r.ok).toBe(true);
  });

  it("codex passes with a saved auth.json even without a key", async () => {
    const r = await preflightCodingAgent("codex", "codex", deps({
      fileExists: async (p) => p.endsWith(".codex/auth.json"),
    }));
    expect(r.ok).toBe(true);
  });

  it("codex fails closed with neither key nor auth.json, and names the fix", async () => {
    const r = await preflightCodingAgent("codex", "codex", deps());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/CODEX_API_KEY|OPENAI_API_KEY|codex login/i);
  });

  it("grok requires XAI_API_KEY or a session token file", async () => {
    expect((await preflightCodingAgent("grok", "grok", deps())).ok).toBe(false);
    expect((await preflightCodingAgent("grok", "grok", deps({ env: { XAI_API_KEY: "xai" } }))).ok).toBe(true);
  });

  it("openrouter requires OPENROUTER_API_KEY", async () => {
    expect((await preflightCodingAgent("openrouter", "hermes", deps())).ok).toBe(false);
    expect((await preflightCodingAgent("openrouter", "hermes", deps({ env: { OPENROUTER_API_KEY: "or" } }))).ok).toBe(true);
  });

  it("openrouter requires OPENROUTER_API_KEY for every harness, and only that key", async () => {
    for (const harness of ["hermes", "codex"] as const) {
      const otherKeys = deps({ env: { OPENAI_API_KEY: "sk", CODEX_API_KEY: "sk", ANTHROPIC_API_KEY: "sk" } });
      const missing = await preflightCodingAgent("openrouter", harness, otherKeys, { openRouterHarness: harness });
      expect(missing.ok).toBe(false);
      expect(missing.reason).toContain(`openrouter/${harness} has no usable credential`);
      expect(missing.reason).toMatch(/OPENROUTER_API_KEY/);

      const granted = await preflightCodingAgent(
        "openrouter",
        harness,
        deps({ env: { OPENROUTER_API_KEY: "or" } }),
        { openRouterHarness: harness },
      );
      expect(granted.ok).toBe(true);
    }
  });

  it("names the openrouter harness and the binary it actually probed", async () => {
    const missingBinary = deps({ hasBinary: async () => false, env: { OPENROUTER_API_KEY: "or" } });
    const codex = await preflightCodingAgent("openrouter", "codex", missingBinary, { openRouterHarness: "codex" });
    expect(codex.ok).toBe(false);
    expect(codex.reason).toContain('openrouter/codex CLI "codex" not found on PATH');

    const hermes = await preflightCodingAgent("openrouter", "hermes", missingBinary, { openRouterHarness: "hermes" });
    expect(hermes.ok).toBe(false);
    expect(hermes.reason).toContain('openrouter/hermes CLI "hermes" not found on PATH');
  });

  it("falls back to the bare agent name when no harness context is supplied", async () => {
    const r = await preflightCodingAgent("openrouter", "hermes", deps({ hasBinary: async () => false }));
    expect(r.reason).toContain('openrouter CLI "hermes" not found on PATH');
  });

  it("gemini fails closed without creds and names the install path", async () => {
    const r = await preflightCodingAgent("gemini", "gemini", deps());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/GEMINI_API_KEY/);
    expect(r.reason).toMatch(/@google\/gemini-cli/);
  });

  it("gemini passes with any Google credential source", async () => {
    expect((await preflightCodingAgent("gemini", "gemini", deps({ env: { GEMINI_API_KEY: "g" } }))).ok).toBe(true);
    expect((await preflightCodingAgent("gemini", "gemini", deps({ env: { GOOGLE_API_KEY: "g" } }))).ok).toBe(true);
    expect((await preflightCodingAgent("gemini", "gemini", deps({ env: { GOOGLE_APPLICATION_CREDENTIALS: "/adc.json" } }))).ok).toBe(true);
  });

  it("gemini passes with a cached OAuth login", async () => {
    const r = await preflightCodingAgent("gemini", "gemini", deps({
      fileExists: async (p) => p.endsWith(".gemini/oauth_creds.json"),
    }));
    expect(r.ok).toBe(true);
  });

  it("claude fails closed without creds and names the fix", async () => {
    const r = await preflightCodingAgent("claude", "claude", deps());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/ANTHROPIC_API_KEY/);
  });

  it("claude passes with ANTHROPIC_API_KEY or a saved login", async () => {
    expect((await preflightCodingAgent("claude", "claude", deps({ env: { ANTHROPIC_API_KEY: "sk" } }))).ok).toBe(true);
    expect((await preflightCodingAgent("claude", "claude", deps({
      fileExists: async (p) => p.endsWith(".claude.json"),
    }))).ok).toBe(true);
    expect((await preflightCodingAgent("claude", "claude", deps({
      fileExists: async (p) => p.endsWith(".claude"),
    }))).ok).toBe(true);
  });
});
