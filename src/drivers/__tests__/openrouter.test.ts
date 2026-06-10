/**
 * OpenRouter preset tests — env-mapped factory over OpenAICompatDriver.
 * All I/O is faked via fetchImpl; env is stubbed/restored per test.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createOpenRouterDriver } from "../openrouter.js";

const messages = [{ role: "user" as const, content: "hi" }];

afterEach(() => vi.unstubAllEnvs());

function captureFetch() {
  const captured = { url: "", body: {} as Record<string, unknown>, headers: {} as Record<string, string> };
  const fetchImpl = async (url: string, init?: RequestInit) => {
    captured.url = url;
    captured.body = JSON.parse(init?.body as string);
    captured.headers = (init?.headers ?? {}) as Record<string, string>;
    return { ok: true, json: async () => ({ choices: [{ message: { content: "ok" } }] }) };
  };
  return { captured, fetchImpl: fetchImpl as unknown as typeof fetch };
}

describe("createOpenRouterDriver", () => {
  it("defaults to openrouter.ai/api/v1 + openrouter/auto, sends Bearer OPENROUTER_API_KEY, names itself openrouter:<model>", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    vi.stubEnv("OPENROUTER_BASE_URL", "");
    vi.stubEnv("OPENROUTER_MODEL", "");
    const { captured, fetchImpl } = captureFetch();

    const driver = createOpenRouterDriver({ fetchImpl });
    const result = await driver.chat({ messages, tools: [] });

    expect(captured.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(captured.body.model).toBe("openrouter/auto");
    expect(captured.headers.Authorization).toBe("Bearer sk-or-test");
    expect(driver.name).toBe("openrouter:openrouter/auto");
    expect(result.content).toBe("ok");
  });

  it("honors OPENROUTER_BASE_URL and OPENROUTER_MODEL overrides", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    vi.stubEnv("OPENROUTER_BASE_URL", "https://or-proxy.example/api/v1");
    vi.stubEnv("OPENROUTER_MODEL", "anthropic/claude-3.5-haiku");
    const { captured, fetchImpl } = captureFetch();

    const driver = createOpenRouterDriver({ fetchImpl });
    await driver.chat({ messages, tools: [] });

    expect(captured.url).toBe("https://or-proxy.example/api/v1/chat/completions");
    expect(captured.body.model).toBe("anthropic/claude-3.5-haiku");
    expect(driver.name).toBe("openrouter:anthropic/claude-3.5-haiku");
  });

  it("throws an actionable error when OPENROUTER_API_KEY is missing", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    expect(() => createOpenRouterDriver()).toThrow(/OPENROUTER_API_KEY/);
  });
});
