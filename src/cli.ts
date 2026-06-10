#!/usr/bin/env node
/** CLI entry point — progress to stderr, final answer to stdout. No args opens chat. */
import { createUnifiedClient } from "./client/unified.js";
import type { AgentEvent } from "./types.js";
import { parseCliArgs, taskAdd, taskList, taskShow, runsLog, type CliDeps } from "./cli-commands.js";
import { resolveRunOptions, type ChatSession } from "./chat-commands.js";
import { loadSkills, findSkill } from "./skills.js";
import { runRepl } from "./frontends/repl.js";

async function main() {
  const argv = process.argv.slice(2);
  const parsed = parseCliArgs(argv);

  // -------------------------------------------------------------------------
  // Interactive chat (default with no args) — full REPL with /commands
  // -------------------------------------------------------------------------
  if (parsed.command === "chat") {
    await runRepl({ driver: parsed.driver, skill: parsed.skill });
    return;
  }

  // -------------------------------------------------------------------------
  // Subcommands: task-add / task-list / task-show / runs-log
  // -------------------------------------------------------------------------
  if (parsed.command !== "run") {
    const deps: CliDeps = {
      env: process.env as Record<string, string | undefined>,
      fetchImpl: fetch,
      stdout: (line: string) => console.log(line),
    };

    switch (parsed.command) {
      case "task-add":
        await taskAdd(deps, parsed.text ?? "", { driver: parsed.driver, maxAttempts: parsed.maxAttempts });
        break;
      case "task-list":
        await taskList(deps);
        break;
      case "task-show":
        await taskShow(deps, parsed.id);
        break;
      case "runs-log":
        await runsLog(deps, parsed.id);
        break;
    }
    return;
  }

  // -------------------------------------------------------------------------
  // One-shot run — optional --driver/--skill carried into the run options
  // -------------------------------------------------------------------------
  const task = parsed.text.trim();
  if (!task) {
    console.error('Usage: tachi-agent "<task>" [--driver <name>] [--skill <name>]');
    process.exit(1);
  }

  // Resolve the skill up front so an unknown name fails actionably, pre-run.
  const session: ChatSession = {};
  if (parsed.driver) session.driver = parsed.driver;
  if (parsed.skill) {
    const skills = await loadSkills();
    const skill = findSkill(skills, parsed.skill);
    if (!skill) {
      const names = skills.map((s) => s.name).join(", ") || "(none — add .md files under .tachi/skills)";
      console.error(`✖ unknown skill "${parsed.skill}" — available: ${names}`);
      process.exit(1);
    }
    session.skill = skill;
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
    // Driver precedence (--driver > skill.driver) lives in resolveRunOptions.
    const res = await client.run(task, { signal: controller.signal, onEvent, ...resolveRunOptions(session) });
    console.log("\n" + res.answer); // final answer to STDOUT (progress went to stderr)
  } finally {
    await client.close(); // always tear down MCP child processes (local) / no-op (daemon)
  }
}

main().catch((e) => {
  console.error(`\n✖ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
