/**
 * HermesDriver unit tests — all I/O is faked via cfg.fetchImpl, no network.
 */
import { describe, it, expect } from "vitest";
import { HermesDriver, HermesUnavailableError } from "../hermes.js";
import type { AgentTool } from "../../types.js";

const tool: AgentTool = { name: "tachibot_jury", description: "d", parameters: { type: "object" } };
const messages = [{ role: "user" as const, content: "hi" }];

describe("HermesDriver", () => {
  it("calls OpenAI-compat /chat/completions with tools + temperature, parses choices[0].message", async () => {
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

    const driver = new HermesDriver({
      baseUrl: "http://127.0.0.1:8080/v1",
      model: "Hermes-3-Llama-3.1-8B",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await driver.chat({ messages, tools: [tool] });

    // URL must hit OpenAI-compat /chat/completions
    expect(capturedUrl).toBe("http://127.0.0.1:8080/v1/chat/completions");

    // model passed through unchanged
    expect(capturedBody.model).toBe("Hermes-3-Llama-3.1-8B");

    // temperature default 0.4 at top level (OpenAI shape, not nested in options)
    expect(capturedBody.temperature).toBe(0.4);

    // stream must be false
    expect(capturedBody.stream).toBe(false);

    // no API key configured → no Authorization header
    expect(capturedHeaders.Authorization).toBeUndefined();

    // tool schema passed through OpenAI function shape
    const tools = capturedBody.tools as Array<{ type: string; function: { name: string } }>;
    expect(tools[0].type).toBe("function");
    expect(tools[0].function.name).toBe("tachibot_jury");

    // dynamic driver name
    expect(driver.name).toBe("hermes:Hermes-3-Llama-3.1-8B");

    // parsed response (arguments JSON string → object)
    expect(result.content).toBe("hi");
    expect(result.toolCalls).toEqual([{ name: "tachibot_jury", arguments: { q: "x" } }]);
  });

  it("coalesces null content to '' and parses object-form tool arguments", async () => {
    const fetchImpl = async () => ({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ function: { name: "t", arguments: { a: 1 } } }],
            },
          },
        ],
      }),
    });

    const driver = new HermesDriver({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await driver.chat({ messages, tools: [] });

    expect(result.content).toBe("");
    expect(result.toolCalls[0].arguments).toEqual({ a: 1 });
  });

  it("throws HermesUnavailableError on a non-ok response", async () => {
    const fetchImpl = async () => ({ ok: false, status: 500, statusText: "err" });

    const driver = new HermesDriver({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(driver.chat({ messages, tools: [] })).rejects.toBeInstanceOf(HermesUnavailableError);
  });

  it("throws HermesUnavailableError when fetch rejects", async () => {
    const fetchImpl = async () => { throw new Error("ECONNREFUSED"); };

    const driver = new HermesDriver({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(driver.chat({ messages, tools: [] })).rejects.toBeInstanceOf(HermesUnavailableError);
  });

  it("sends Authorization: Bearer header when an apiKey is configured, and uses the default base URL", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};

    const fetchImpl = async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return { ok: true, json: async () => ({ choices: [{ message: { content: "ok" } }] }) };
    };

    const driver = new HermesDriver({ apiKey: "sk-test", fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await driver.chat({ messages, tools: [] });

    // default base URL includes the OpenAI /v1 segment and the endpoint is appended
    expect(capturedUrl).toBe("http://127.0.0.1:8080/v1/chat/completions");
    expect(capturedHeaders.Authorization).toBe("Bearer sk-test");
    expect(result.content).toBe("ok");
    expect(result.toolCalls).toEqual([]);
  });
});
