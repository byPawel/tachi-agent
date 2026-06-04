#!/usr/bin/env node
/**
 * Interactive REPL — chat with the local-first orchestration brain (OpenClaw-style,
 * but for multi-model reasoning + memory, not code editing). Persistent runtime;
 * each turn runs the agent, streams progress, and continuity comes from dokoro
 * memory (recall/log each turn). Ctrl-C stops the current turn; Ctrl-D / /exit quits.
 */
import readline from "node:readline";
import { buildAgentFromEnv } from "../runtime.js";
import type { AgentEvent } from "../types.js";

const HELP = `commands:
  /help          show this
  /tools         list the agent's available tools
  /model         show the current local model
  /exit, /quit   leave (Ctrl-D also exits)
  Ctrl-C         stop the current turn
anything else is sent to the agent.`;

export type Command =
  | { kind: "empty" }
  | { kind: "exit" }
  | { kind: "help" }
  | { kind: "tools" }
  | { kind: "model" }
  | { kind: "run"; text: string };

/** Parse a REPL line into a command. Pure + unit-testable. */
export function parseCommand(line: string): Command {
  const t = line.trim();
  if (!t) return { kind: "empty" };
  if (t === "/exit" || t === "/quit") return { kind: "exit" };
  if (t === "/help") return { kind: "help" };
  if (t === "/tools") return { kind: "tools" };
  if (t === "/model") return { kind: "model" };
  return { kind: "run", text: t };
}

async function main(): Promise<void> {
  const rt = await buildAgentFromEnv();
  console.error(`tachi-agent REPL · ${rt.driver.name} · ${rt.toolCount} tools · type /help, /exit`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "tachi › " });

  const onEvent = (e: AgentEvent) => {
    if (e.type === "step") process.stderr.write(`  · step ${e.iteration}\n`);
    else if (e.type === "assistant" && e.toolCalls.length) process.stderr.write(`  🔧 ${e.toolCalls.map((c) => c.name).join(", ")}\n`);
    else if (e.type === "tool-result") process.stderr.write(`     ↳ ${e.name}\n`);
  };

  let active: AbortController | null = null;

  rl.prompt();
  rl.on("line", async (line) => {
    const cmd = parseCommand(line);
    switch (cmd.kind) {
      case "empty": return rl.prompt();
      case "exit": return rl.close();
      case "help": console.log(HELP); return rl.prompt();
      case "tools": console.log(rt.host.tools().map((t) => t.name).join("\n") || "(none)"); return rl.prompt();
      case "model": console.log(rt.driver.name); return rl.prompt();
      case "run": {
        active = new AbortController();
        rl.pause();
        try {
          const res = await rt.orchestrator({ signal: active.signal, onEvent }).run(cmd.text);
          console.log("\n" + res.answer + "\n");
        } catch (e) {
          console.error(`✖ ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          active = null;
          rl.resume();
          rl.prompt();
        }
      }
    }
  });

  // Ctrl-C: abort the running turn if any, else exit.
  rl.on("SIGINT", () => {
    if (active) { active.abort(); process.stderr.write("\n⏹  stopped this turn.\n"); }
    else rl.close();
  });

  rl.on("close", async () => { await rt.close(); process.exit(0); });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
