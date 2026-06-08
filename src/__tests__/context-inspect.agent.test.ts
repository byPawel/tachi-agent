/**
 * context-inspect.agent.test.ts
 *
 * Integration: the Orchestrator must emit a context-inspect event immediately
 * before EVERY driver.chat call when (and only when) context inspection is enabled.
 * The default (disabled) path must write nothing.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Orchestrator } from "../agent.js";
import type { Driver, ToolHost, AgentTool, DriverResult } from "../types.js";
import type { ContextInspectEvent } from "../context-inspect.js";

const TOOLS: AgentTool[] = [
  {
    name: "tachibot_jury",
    description: "multi-model jury",
    parameters: { type: "object", properties: { question: { type: "string" } } },
  },
];

const fakeHost = (): ToolHost => ({ tools: () => TOOLS, call: async () => "jury result" });

function scriptDriver(script: DriverResult[]): Driver {
  let i = 0;
  return { name: "scripted", chat: async () => script[Math.min(i++, script.length - 1)] };
}

/** Two tool turns then a final answer → driver.chat is called 3 times. */
const threeTurnDriver = () =>
  scriptDriver([
    { content: "step 1", toolCalls: [{ name: "tachibot_jury", arguments: { question: "a?" } }] },
    { content: "step 2", toolCalls: [{ name: "tachibot_jury", arguments: { question: "b?" } }] },
    { content: "Final.", toolCalls: [] },
  ]);

function ciFiles(dir: string): string[] {
  const ciDir = join(dir, ".tachi", "context-inspect");
  return existsSync(ciDir) ? readdirSync(ciDir) : [];
}

describe("Orchestrator context-inspect wiring", () => {
  let dir: string;
  const ORIG_CWD = process.cwd();
  const ORIG_FLAG = process.env.TACHI_CONTEXT_INSPECT;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tachi-ci-agent-"));
    process.chdir(dir);
    delete process.env.TACHI_CONTEXT_INSPECT;
  });

  afterEach(() => {
    process.chdir(ORIG_CWD);
    rmSync(dir, { recursive: true, force: true });
    if (ORIG_FLAG === undefined) delete process.env.TACHI_CONTEXT_INSPECT;
    else process.env.TACHI_CONTEXT_INSPECT = ORIG_FLAG;
  });

  it("writes NOTHING by default (disabled path is unchanged)", async () => {
    const res = await new Orchestrator(threeTurnDriver(), fakeHost(), undefined).run("go");
    expect(res.haltedBy).toBe("final-answer");
    expect(existsSync(join(dir, ".tachi"))).toBe(false);
  });

  it("emits one event per driver.chat call when contextInspect:true", async () => {
    const res = await new Orchestrator(threeTurnDriver(), fakeHost(), undefined, {
      contextInspect: true,
    }).run("go");
    expect(res.haltedBy).toBe("final-answer");
    expect(res.iterations).toBe(3);

    const files = ciFiles(dir);
    expect(files).toHaveLength(1);
    const lines = readFileSync(join(dir, ".tachi", "context-inspect", files[0]), "utf8").trim().split("\n");
    // 3 driver.chat calls → 3 events
    expect(lines).toHaveLength(3);
    const events = lines.map((l) => JSON.parse(l) as ContextInspectEvent);
    // turn === the loop iteration counter (1-based)
    expect(events.map((e) => e.turn)).toEqual([1, 2, 3]);
    for (const e of events) {
      expect(e.event).toBe("context_inspect");
      expect(e.layers.length).toBeGreaterThan(0);
      expect(e.layers.find((l) => l.name === "tool")).toBeDefined();
    }
  });

  it("emits when enabled via TACHI_CONTEXT_INSPECT env var (no opts)", async () => {
    process.env.TACHI_CONTEXT_INSPECT = "true";
    await new Orchestrator(threeTurnDriver(), fakeHost(), undefined).run("go");
    const files = ciFiles(dir);
    expect(files).toHaveLength(1);
    const lines = readFileSync(join(dir, ".tachi", "context-inspect", files[0]), "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
  });
});
