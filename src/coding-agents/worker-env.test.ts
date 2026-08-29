import { describe, it, expect } from "vitest";
import { buildWorkerEnv } from "./worker-env.js";

const base = {
  PATH: "/usr/bin", HOME: "/home/dev", TERM: "xterm",
  OPENAI_API_KEY: "sk-openai", XAI_API_KEY: "xai-key",
  OPENROUTER_API_KEY: "or-key", CODEX_API_KEY: "sk-codex",
  GATEWAY_TOKENS: "secret-bearer", AWS_SECRET_ACCESS_KEY: "aws-secret",
  DATABASE_URL: "postgres://nope",
} as NodeJS.ProcessEnv;

describe("buildWorkerEnv", () => {
  it("passes PATH/HOME but drops unrelated secrets for codex", () => {
    const env = buildWorkerEnv("codex", base);
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/dev");
    expect(env.CODEX_API_KEY).toBe("sk-codex");
    expect(env.OPENAI_API_KEY).toBe("sk-openai"); // codex fallback cred
    expect(env.GATEWAY_TOKENS).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it("gives grok only its xAI key, not OpenAI/OpenRouter keys", () => {
    const env = buildWorkerEnv("grok", base);
    expect(env.XAI_API_KEY).toBe("xai-key");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
  });

  it("gives openrouter its OpenRouter key and model hints", () => {
    const env = buildWorkerEnv("openrouter", { ...base, TACHI_OPENROUTER_CODING_MODEL: "qwen/qwen3-coder" });
    expect(env.OPENROUTER_API_KEY).toBe("or-key");
    expect(env.TACHI_OPENROUTER_CODING_MODEL).toBe("qwen/qwen3-coder");
    expect(env.XAI_API_KEY).toBeUndefined();
  });

  it("honors TACHI_WORKER_ENV_ALLOW extra allowlist (comma-separated)", () => {
    const env = buildWorkerEnv("codex", { ...base, TACHI_WORKER_ENV_ALLOW: "DATABASE_URL,FOO", FOO: "bar" });
    expect(env.DATABASE_URL).toBe("postgres://nope");
    expect(env.FOO).toBe("bar");
  });

  it("never mutates the base env object", () => {
    const snapshot = { ...base };
    buildWorkerEnv("codex", base);
    expect(base).toEqual(snapshot);
  });

  it("stamps TACHI_CODING_DEPTH=1 for every agent", () => {
    for (const agent of ["codex", "grok", "hermes", "openrouter"] as const) {
      expect(buildWorkerEnv(agent, base).TACHI_CODING_DEPTH).toBe("1");
    }
  });

  it("overrides an inherited TACHI_CODING_DEPTH even when allowlisted", () => {
    const env = buildWorkerEnv("codex", {
      ...base,
      TACHI_CODING_DEPTH: "0",
      TACHI_WORKER_ENV_ALLOW: "TACHI_CODING_DEPTH",
    });
    expect(env.TACHI_CODING_DEPTH).toBe("1");
  });
});
