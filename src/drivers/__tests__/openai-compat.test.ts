/**
 * OpenAICompatDriver unit tests — the generic OpenAI-compatible /chat/completions
 * core that hermes/openai/openrouter presets are built on. All I/O is faked via
 * cfg.fetchImpl, no network.
 */
import { describe, it, expect } from "vitest";
import { OpenAICompatDriver, OpenAICompatUnavailableError } from "../openai-compat.js";
import type { AgentTool } from "../../types.js";

const tool: AgentTool = { name: "tachibot_jury", description: "d", parameters: { type: "object" } };
const messages = [{ role: "user" as const, content: "hi" }];

describe("OpenAICompatDriver", () => {
  it("posts to <baseUrl>/chat/completions with tools, names itself <namePrefix>:<model>", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};
    let capturedHeaders: Record<string, string> = {};

    const fetchImpl = async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init?.body as string);
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: "hi",
                tool_calls: [{ function: { name: "tachibot_jury", arguments: '{"q":"x"}' } }],
              },
            },
          ],
        }),
      };
    };

    const driver = new OpenAICompatDriver({
      namePrefix: "acme",
      baseUrl: "https://acme.example/v1/", // trailing slash must be stripped
      model: "acme-1",
      apiKey: "sk-acme",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await driver.chat({ messages, tools: [tool] });

    expect(capturedUrl).toBe("https://acme.example/v1/chat/completions");
    expect(capturedBody.model).toBe("acme-1");
    expect(capturedBody.temperature).toBe(0.4);
    expect(capturedBody.stream).toBe(false);
    expect(capturedHeaders.Authorization).toBe("Bearer sk-acme");
    expect(driver.name).toBe("acme:acme-1");
    expect(result.content).toBe("hi");
    expect(result.toolCalls).toEqual([{ name: "tachibot_jury", arguments: { q: "x" } }]);
  });

  it("throws a typed Unavailable error naming the endpoint on a non-ok response", async () => {
    const fetchImpl = async () => ({ ok: false, status: 500, statusText: "err" });
    const driver = new OpenAICompatDriver({
      namePrefix: "acme",
      baseUrl: "https://acme.example/v1",
      model: "acme-1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(driver.chat({ messages, tools: [] })).rejects.toBeInstanceOf(OpenAICompatUnavailableError);
    await expect(driver.chat({ messages, tools: [] })).rejects.toThrow(/https:\/\/acme\.example\/v1/);
  });

  it("wraps fetch rejections in the Unavailable error including the envHint", async () => {
    const fetchImpl = async () => { throw new Error("ECONNREFUSED"); };
    const driver = new OpenAICompatDriver({
      namePrefix: "acme",
      baseUrl: "https://acme.example/v1",
      model: "acme-1",
      envHint: "(set ACME_BASE_URL / ACME_API_KEY)",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(driver.chat({ messages, tools: [] })).rejects.toThrow(/ECONNREFUSED.*ACME_BASE_URL/s);
  });

  it("rethrows errors produced by a custom makeError factory unchanged", async () => {
    class AcmeDown extends OpenAICompatUnavailableError {
      constructor(detail: string) { super(detail); this.name = "AcmeDown"; }
    }
    const fetchImpl = async () => { throw new Error("boom"); };
    const driver = new OpenAICompatDriver({
      namePrefix: "acme",
      baseUrl: "https://acme.example/v1",
      model: "acme-1",
      makeError: (d) => new AcmeDown(d),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(driver.chat({ messages, tools: [] })).rejects.toBeInstanceOf(AcmeDown);
  });
});
