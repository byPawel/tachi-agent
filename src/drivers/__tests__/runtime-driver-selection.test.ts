/**
 * Runtime brain selection — buildAgentFromEnv picks the Driver via TACHI_DRIVER
 * through the registry, and orchestrator(options, driverName) supports a per-run
 * driver override (the multi-heart foundation).
 *
 * No MCP servers are connected (DOKORO_CMD / TACHIBOT_CMD stubbed empty) so the
 * build is pure wiring — no subprocesses, no network.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildAgentFromEnv, type AgentRuntime } from "../../runtime.js";
import type { Driver } from "../../types.js";

let runtime: AgentRuntime | undefined;

beforeEach(() => {
  // Never spawn MCP servers in this suite.
  vi.stubEnv("DOKORO_CMD", "");
  vi.stubEnv("TACHIBOT_CMD", "");
});

afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
  vi.unstubAllEnvs();
});

/** Orchestrator keeps its driver private (compile-time only) — peek for assertions. */
function driverOf(orch: unknown): Driver {
  return (orch as { driver: Driver }).driver;
}

describe("buildAgentFromEnv driver selection (TACHI_DRIVER)", () => {
  it("defaults to the ollama driver when TACHI_DRIVER is unset", async () => {
    vi.stubEnv("TACHI_DRIVER", "");
    runtime = await buildAgentFromEnv();
    expect(runtime.driver.name.startsWith("ollama:")).toBe(true);
  });

  it("selects the hermes driver with TACHI_DRIVER=hermes", async () => {
    vi.stubEnv("TACHI_DRIVER", "hermes");
    runtime = await buildAgentFromEnv();
    expect(runtime.driver.name.startsWith("hermes:")).toBe(true);
  });

  it("selects the openai driver with TACHI_DRIVER=openai when OPENAI_API_KEY is set", async () => {
    vi.stubEnv("TACHI_DRIVER", "openai");
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("OPENAI_MODEL", "");
    runtime = await buildAgentFromEnv();
    expect(runtime.driver.name).toBe("openai:gpt-4o-mini");
  });

  it("rejects an unknown TACHI_DRIVER with an actionable error listing registered drivers", async () => {
    vi.stubEnv("TACHI_DRIVER", "nope");
    await expect(buildAgentFromEnv()).rejects.toThrow(/TACHI_DRIVER.*nope.*ollama/s);
  });
});

describe("per-run driver override (multi-heart foundation)", () => {
  it("orchestrator() without an override uses the runtime's default driver", async () => {
    vi.stubEnv("TACHI_DRIVER", "ollama");
    runtime = await buildAgentFromEnv();
    const orch = runtime.orchestrator();
    expect(driverOf(orch).name.startsWith("ollama:")).toBe(true);
  });

  it("orchestrator(options, driverName) resolves the named driver through the registry", async () => {
    vi.stubEnv("TACHI_DRIVER", "ollama");
    runtime = await buildAgentFromEnv();
    const orch = runtime.orchestrator(undefined, "hermes");
    expect(driverOf(orch).name.startsWith("hermes:")).toBe(true);
    // the runtime's default driver is untouched
    expect(runtime.driver.name.startsWith("ollama:")).toBe(true);
  });

  it("orchestrator(options, unknownName) throws the registry's actionable error", async () => {
    runtime = await buildAgentFromEnv();
    expect(() => runtime!.orchestrator(undefined, "nope")).toThrow(/Unknown driver "nope"/);
  });
});
