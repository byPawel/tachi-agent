import { describe, it, expect } from "vitest";
import { memberSessionId, swarmTraceSession } from "../swarm.js";

describe("swarm session ids", () => {
  it("scopes each member to its own session, distinct from the trace session", () => {
    const t = "trace-1";
    expect(memberSessionId(t, "implementer")).toBe("swarm:trace-1:implementer");
    expect(memberSessionId(t, "critic")).not.toBe(memberSessionId(t, "implementer"));
    expect(swarmTraceSession(t)).toBe("swarm:trace-1");
    expect(swarmTraceSession(t)).not.toBe(memberSessionId(t, "implementer"));
  });
  it("isolates across runs (different traceId → different sessions)", () => {
    expect(memberSessionId("a", "x")).not.toBe(memberSessionId("b", "x"));
  });
});
