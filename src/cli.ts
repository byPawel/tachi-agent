#!/usr/bin/env node
/** CLI entry point — progress to stderr, final answer to stdout. */
import { buildAgentFromEnv } from "./runtime.js";
import type { AgentEvent } from "./types.js";

async function main() {
  const task = process.argv.slice(2).join(" ").trim();
  if (!task) {
    console.error('Usage: tachi-agent "<task>"');
    process.exit(1);
  }

  // Shared wiring: OllamaDriver + McpToolHost (dokoro+tachibot, with the default
  // tool allowlist so a small local model isn't drowned in ~70 tools) + DokoroMemory.
  const rt = await buildAgentFromEnv();

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

  console.error(`🤖 tachi-agent (${rt.driver.name}) · ${rt.toolCount} tools · task: ${task}`);

  try {
    const res = await rt.orchestrator({ signal: controller.signal, onEvent }).run(task);
    console.log("\n" + res.answer); // final answer to STDOUT (progress went to stderr)
  } finally {
    await rt.close(); // always tear down MCP child processes
  }
}

main().catch((e) => {
  console.error(`\n✖ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
