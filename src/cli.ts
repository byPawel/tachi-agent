#!/usr/bin/env node
/** CLI entry point — progress to stderr, final answer to stdout. */
import { Orchestrator } from "./agent.js";
import { OllamaDriver } from "./drivers/ollama.js";
import { McpToolHost, type McpServerConfig } from "./host/mcp.js";
import { DokoroMemory } from "./memory/dokoro.js";
import type { AgentEvent } from "./types.js";

async function main() {
  const task = process.argv.slice(2).join(" ").trim();
  if (!task) {
    console.error('Usage: tachi-agent "<task>"');
    process.exit(1);
  }

  const servers: McpServerConfig[] = [];

  const dokoroVal = process.env.DOKORO_CMD;
  if (dokoroVal && dokoroVal.trim()) {
    const [command, ...args] = dokoroVal.trim().split(/\s+/);
    servers.push({ name: "dokoro", command, args });
  }

  const tachibotVal = process.env.TACHIBOT_CMD;
  if (tachibotVal && tachibotVal.trim()) {
    const [command, ...args] = tachibotVal.trim().split(/\s+/);
    servers.push({ name: "tachibot", command, args });
  }

  const host = new McpToolHost();
  if (servers.length) await host.connect(servers);

  const driver = new OllamaDriver();
  const memory = servers.some((s) => s.name === "dokoro") ? new DokoroMemory(host) : undefined;

  const controller = new AbortController();
  process.on("SIGINT", () => {
    console.error("\n⏹  stopping…");
    controller.abort();
  });

  const onEvent = (e: AgentEvent) => {
    switch (e.type) {
      case "step":
        console.error(`\n— step ${e.iteration} —`);
        break;
      case "assistant":
        if (e.toolCalls.length) {
          console.error(`🔧 ${e.toolCalls.map((c) => c.name).join(", ")}`);
        } else if (e.content) {
          console.error(e.content);
        }
        break;
      case "tool-result":
        console.error(`   ↳ ${e.name}: ${e.result.slice(0, 200)}`);
        break;
      case "final":
        console.error(`\n✅ halted: ${e.haltedBy}`);
        break;
    }
  };

  const orch = new Orchestrator(driver, host, memory, { signal: controller.signal, onEvent });

  console.error(`🤖 tachi-agent (${driver.name}) · ${host.tools().length} tools · task: ${task}`);

  try {
    const res = await orch.run(task);
    console.log("\n" + res.answer); // final answer to STDOUT (progress went to stderr)
  } finally {
    await host.close(); // always tear down MCP child processes
  }
}

main().catch((e) => {
  console.error(`\n✖ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
