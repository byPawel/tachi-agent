#!/usr/bin/env node
/** CLI entry point — progress to stderr, final answer to stdout. */
import { createUnifiedClient } from "./client/unified.js";
import type { AgentEvent } from "./types.js";

async function main() {
  const task = process.argv.slice(2).join(" ").trim();
  if (!task) {
    console.error('Usage: tachi-agent "<task>"');
    process.exit(1);
  }

  // Local-or-daemon: with TACHI_DAEMON_URL set, delegate to the daemon over the gateway;
  // unset, build the in-process runtime (OllamaDriver + McpToolHost + DokoroMemory) exactly
  // as before. `client.run` returns the same RunResult and streams the same AgentEvents.
  const client = await createUnifiedClient(process.env);

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
      case "cost":
        if (e.usd > 0) console.error(`💸 est. cost: $${e.usd.toFixed(3)} over ${e.calls} tool call(s)`);
        break;
      case "final":
        console.error(`\n✅ halted: ${e.haltedBy}`);
        break;
    }
  };

  console.error(
    process.env.TACHI_DAEMON_URL
      ? `🤖 tachi-agent (daemon ${process.env.TACHI_DAEMON_URL}) · task: ${task}`
      : `🤖 tachi-agent (local) · task: ${task}`,
  );

  try {
    const res = await client.run(task, { signal: controller.signal, onEvent });
    console.log("\n" + res.answer); // final answer to STDOUT (progress went to stderr)
  } finally {
    await client.close(); // always tear down MCP child processes (local) / no-op (daemon)
  }
}

main().catch((e) => {
  console.error(`\n✖ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
