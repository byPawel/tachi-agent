/**
 * OllamaDriver unit tests — all I/O is faked via cfg.fetchImpl, no network.
 */
import { describe, it, expect } from "vitest";
import { OllamaDriver, OllamaUnavailableError } from "../ollama.js";
import type { AgentTool } from "../../types.js";

const tool: AgentTool = { name: "tachibot_jury", description: "d", parameters: { type: "object" } };
const messages = [{ role: "user" as const, content: "hi" }];

describe("OllamaDriver", () => {
  it("calls native /api/chat with num_ctx + tools, strips :latest, parses object tool_calls", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};

    const fetchImpl = async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init?.body as string);
      return {
        ok: true,
        json: async () => ({
          message: {
            content: "hi",
            tool_calls: [{ function: { name: "tachibot_jury", arguments: { q: "x" } } }],
          },
        }),
      };
    };

    const driver = new OllamaDriver({ model: "qwen2.5:latest", fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await driver.chat({ messages, tools: [tool] });

    // URL must hit native /api/chat, NOT /v1
    expect(capturedUrl).toMatch(/\/api\/chat$/);
    expect(capturedUrl).not.toContain("/v1");

    // :latest must be stripped from model name
    expect(capturedBody.model).toBe("qwen2.5");

    // num_ctx default is 8192
    expect((capturedBody.options as Record<string, unknown>).num_ctx).toBe(8192);

    // stream must be false
    expect(capturedBody.stream).toBe(false);

    // tool schema passed through
    const tools = capturedBody.tools as Array<{ function: { name: string } }>;
    expect(tools[0].function.name).toBe("tachibot_jury");

    // parsed response
    expect(result.content).toBe("hi");
    expect(result.toolCalls).toEqual([{ name: "tachibot_jury", arguments: { q: "x" } }]);
  });

  it("parses tool_call arguments given as a JSON string", async () => {
    const fetchImpl = async () => ({
      ok: true,
      json: async () => ({
        message: {
          content: "",
          tool_calls: [{ function: { name: "t", arguments: '{"a":1}' } }],
        },
      }),
    });

    const driver = new OllamaDriver({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await driver.chat({ messages, tools: [] });

    expect(result.toolCalls[0].arguments).toEqual({ a: 1 });
  });

  it("throws OllamaUnavailableError on a non-ok response", async () => {
    const fetchImpl = async () => ({ ok: false, status: 500, statusText: "err" });

    const driver = new OllamaDriver({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(driver.chat({ messages, tools: [] })).rejects.toBeInstanceOf(OllamaUnavailableError);
  });

  it("throws OllamaUnavailableError when fetch rejects", async () => {
    const fetchImpl = async () => { throw new Error("ECONNREFUSED"); };

    const driver = new OllamaDriver({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(driver.chat({ messages, tools: [] })).rejects.toBeInstanceOf(OllamaUnavailableError);
  });
});
