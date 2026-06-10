/**
 * register.ts side-effect test — importing it registers the built-in drivers by name.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import "../register.js"; // side-effect: registers "ollama", "hermes", "openai", "openrouter"
import { getDriver, listDrivers } from "../../registry.js";
import { HermesDriver } from "../hermes.js";
import { OllamaDriver } from "../ollama.js";
import { OpenAICompatDriver } from "../openai-compat.js";

afterEach(() => vi.unstubAllEnvs());

describe("driver registration", () => {
  it("registers ollama, hermes, openai and openrouter factories", () => {
    expect(listDrivers()).toEqual(expect.arrayContaining(["hermes", "ollama", "openai", "openrouter"]));
  });

  it("getDriver('hermes') yields a HermesDriver instance", () => {
    expect(getDriver("hermes")).toBeInstanceOf(HermesDriver);
  });

  it("getDriver('ollama') yields an OllamaDriver instance", () => {
    expect(getDriver("ollama")).toBeInstanceOf(OllamaDriver);
  });

  it("getDriver('openai') yields a named OpenAICompatDriver when OPENAI_API_KEY is set", () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("OPENAI_MODEL", "");
    const driver = getDriver("openai");
    expect(driver).toBeInstanceOf(OpenAICompatDriver);
    expect(driver.name).toBe("openai:gpt-4o-mini");
  });

  it("getDriver('openai') throws an actionable error without OPENAI_API_KEY", () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    expect(() => getDriver("openai")).toThrow(/OPENAI_API_KEY/);
  });

  it("getDriver('openrouter') yields a named OpenAICompatDriver when OPENROUTER_API_KEY is set", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    vi.stubEnv("OPENROUTER_MODEL", "");
    const driver = getDriver("openrouter");
    expect(driver).toBeInstanceOf(OpenAICompatDriver);
    expect(driver.name).toBe("openrouter:openrouter/auto");
  });

  it("getDriver('openrouter') throws an actionable error without OPENROUTER_API_KEY", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    expect(() => getDriver("openrouter")).toThrow(/OPENROUTER_API_KEY/);
  });
});
