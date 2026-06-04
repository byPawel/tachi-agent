import { describe, it, expect } from "vitest";
import {
  registerDriver, getDriver, listDrivers, createOrchestrator, Orchestrator,
} from "../index.js";
import type { Driver, ToolHost, DriverResult } from "../index.js";

const fakeDriver = (name: string, result: DriverResult = { content: "ok", toolCalls: [] }): Driver =>
  ({ name, chat: async () => result });
const fakeHost: ToolHost = { tools: () => [], call: async () => "" };

describe("extensibility — driver registry + factory", () => {
  it("registers, lists, and resolves a driver by name", () => {
    registerDriver("unit-driver", () => fakeDriver("unit-driver"));
    expect(listDrivers()).toContain("unit-driver");
    expect(getDriver("unit-driver").name).toBe("unit-driver");
  });

  it("throws a helpful error for an unknown driver", () => {
    expect(() => getDriver("nope")).toThrow(/Unknown driver "nope"/);
  });

  it("createOrchestrator accepts a registered name OR a raw instance", async () => {
    registerDriver("named", () => fakeDriver("named"));
    const byName = createOrchestrator({ driver: "named", host: fakeHost });
    const byInstance = createOrchestrator({ driver: fakeDriver("inst"), host: fakeHost });
    expect(byName).toBeInstanceOf(Orchestrator);
    expect((await byName.run("hi")).answer).toBe("ok");
    expect((await byInstance.run("hi")).answer).toBe("ok");
  });
});

describe("stop control — AbortSignal", () => {
  it("halts with 'aborted' when the signal is already aborted", async () => {
    const driver = fakeDriver("loops", { content: "", toolCalls: [{ name: "x", arguments: {} }] });
    const res = await createOrchestrator({
      driver,
      host: fakeHost,
      options: { signal: AbortSignal.abort() },
    }).run("stop me");
    expect(res.haltedBy).toBe("aborted");
    expect(res.iterations).toBe(0);
  });

  it("stops mid-run once aborted between steps", async () => {
    const controller = new AbortController();
    let calls = 0;
    const driver: Driver = {
      name: "tick",
      chat: async () => {
        calls++;
        if (calls === 2) controller.abort(); // abort after the 2nd step starts queuing
        return { content: "", toolCalls: [{ name: "x", arguments: {} }] };
      },
    };
    const host: ToolHost = { tools: () => [{ name: "x", description: "", parameters: {} }], call: async () => "ok" };
    const res = await createOrchestrator({
      driver, host, options: { maxIterations: 50, signal: controller.signal },
    }).run("go");
    expect(res.haltedBy).toBe("aborted");
    expect(res.iterations).toBeLessThan(50);
  });
});
