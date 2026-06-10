import { describe, it, expect } from "vitest";
import { Orchestrator } from "../agent.js";
import type { Driver, ToolHost, AgentTool } from "../types.js";

const TOOLS: AgentTool[] = [
  { name: "tachibot_jury", description: "", parameters: {} },
  { name: "tachibot_grok_search", description: "", parameters: {} },
];
const host: ToolHost = { tools: () => TOOLS, call: async () => "ok" };

function seeingDriver(seen: string[][]): Driver {
  return { name: "fake", chat: async ({ tools }) => { seen.push(tools.map((t) => t.name)); return { content: "done", toolCalls: [] }; } };
}

describe("allowTools option", () => {
  it("filters the tool surface for the run", async () => {
    const seen: string[][] = [];
    const orch = new Orchestrator(seeingDriver(seen), host, undefined, { allowTools: ["tachibot_jury"] });
    await orch.run("hi");
    expect(seen[0]).toEqual(["tachibot_jury"]);
  });
  it("unknown names expose nothing extra; unset → full surface", async () => {
    const seen: string[][] = [];
    await new Orchestrator(seeingDriver(seen), host, undefined, { allowTools: ["nope"] }).run("a");
    await new Orchestrator(seeingDriver(seen), host, undefined, {}).run("b");
    expect(seen[0]).toEqual([]);
    expect(seen[1]).toEqual(["tachibot_jury", "tachibot_grok_search"]);
  });
});
