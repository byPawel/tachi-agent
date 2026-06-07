/**
 * register.ts side-effect test — importing it registers both drivers by name.
 */
import { describe, it, expect } from "vitest";
import "../register.js"; // side-effect: registers "ollama" and "hermes"
import { getDriver, listDrivers } from "../../registry.js";
import { HermesDriver } from "../hermes.js";
import { OllamaDriver } from "../ollama.js";

describe("driver registration", () => {
  it("registers hermes and ollama factories", () => {
    expect(listDrivers()).toEqual(expect.arrayContaining(["hermes", "ollama"]));
  });

  it("getDriver('hermes') yields a HermesDriver instance", () => {
    expect(getDriver("hermes")).toBeInstanceOf(HermesDriver);
  });

  it("getDriver('ollama') yields an OllamaDriver instance", () => {
    expect(getDriver("ollama")).toBeInstanceOf(OllamaDriver);
  });
});
