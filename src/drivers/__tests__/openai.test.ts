/**
 * OpenAI preset tests — env-mapped factory over OpenAICompatDriver.
 * All I/O is faked via fetchImpl; env is stubbed/restored per test.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createOpenAIDriver } from "../openai.js";

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

describe("createOpenAIDriver", () => {
  it("defaults to api.openai.com/v1 + gpt-4o-mini, sends Bearer OPENAI_API_KEY, names itself openai:<model>", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-openai-test");
    vi.stubEnv("OPENAI_BASE_URL", "");
    vi.stubEnv("OPENAI_MODEL", "");
    const { captured, fetchImpl } = captureFetch();

    const driver = createOpenAIDriver({ fetchImpl });
    const result = await driver.chat({ messages, tools: [] });

    expect(captured.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(captured.body.model).toBe("gpt-4o-mini");
    expect(captured.headers.Authorization).toBe("Bearer sk-openai-test");
    expect(driver.name).toBe("openai:gpt-4o-mini");
    expect(result.content).toBe("ok");
  });

  it("honors OPENAI_BASE_URL and OPENAI_MODEL overrides", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-openai-test");
    vi.stubEnv("OPENAI_BASE_URL", "https://proxy.example/v1");
    vi.stubEnv("OPENAI_MODEL", "gpt-4.1");
    const { captured, fetchImpl } = captureFetch();

    const driver = createOpenAIDriver({ fetchImpl });
    await driver.chat({ messages, tools: [] });

    expect(captured.url).toBe("https://proxy.example/v1/chat/completions");
    expect(captured.body.model).toBe("gpt-4.1");
    expect(driver.name).toBe("openai:gpt-4.1");
  });

  it("throws an actionable error when OPENAI_API_KEY is missing", () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    expect(() => createOpenAIDriver()).toThrow(/OPENAI_API_KEY/);
  });
});
