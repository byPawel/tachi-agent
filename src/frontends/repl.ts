#!/usr/bin/env node
/**
 * Interactive REPL — chat with the local-first orchestration brain (OpenClaw-style,
 * but for multi-model reasoning + memory, not code editing). Persistent runtime;
 * each turn runs the agent, streams progress, and continuity comes from dokoro
 * memory (recall/log each turn). Ctrl-C stops the current turn; Ctrl-D / /exit quits.
 *
 * Commands are the UNIFIED chat layer (chat-commands.ts) — identical surface to
 * Telegram. The prompt shows the active session (`tachi [driver·skill] › `),
 * rewritten tasks are echoed (`→ <text>`) to stderr before running (council
 * transparency finding), and input history persists at ~/.tachi-agent/repl_history
 * (cap 1000 lines, fail-soft IO).
 */
import readline from "node:readline";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { buildAgentFromEnv } from "../runtime.js";
import { localClient, createUnifiedClient, type UnifiedClient } from "../client/unified.js";
import {
  handleChatLine,
  resolveRunOptions,
  type ChatDeps,
  type ChatSession,
} from "../chat-commands.js";
import { loadSkills, findSkill } from "../skills.js";
import { taskAdd, taskList, taskShow, type CliDeps } from "../cli-commands.js";
import type { AgentEvent } from "../types.js";

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Session-aware prompt: `tachi › ` bare, `tachi [openai] › ` with a driver,
 * `tachi [openai·researcher] › ` with both. The driver shown is the EFFECTIVE
 * one (session.driver > skill.driver — mirrors resolveRunOptions).
 */
export function formatPrompt(session: ChatSession): string {
  const driver = session.driver ?? session.skill?.driver;
  const parts = [driver, session.skill?.name].filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  return parts.length ? `tachi [${parts.join("·")}] › ` : "tachi › ";
}

/** Default history file location: ~/.tachi-agent/repl_history. */
export function historyFilePath(home: string = homedir()): string {
  return join(home, ".tachi-agent", "repl_history");
}

/** Load history lines (oldest first), skipping blanks. Fail-soft → []. */
export async function loadHistory(file: string = historyFilePath()): Promise<string[]> {
  try {
    const raw = await readFile(file, "utf8");
    return raw.split("\n").filter((l) => l.trim() !== "");
  } catch {
    return [];
  }
}

/** Persist history (oldest first), keeping the most recent `cap` lines. Fail-soft. */
export async function saveHistory(
  lines: string[],
  file: string = historyFilePath(),
  cap = 1000,
): Promise<void> {
  try {
    await mkdir(dirname(file), { recursive: true });
    const kept = lines.slice(-cap);
    await writeFile(file, kept.length ? kept.join("\n") + "\n" : "", "utf8");
  } catch {
    /* fail-soft — history is a convenience, never an error */
  }
}

// ---------------------------------------------------------------------------
// Daemon-bound queue commands — wrap cli-commands.ts fns with a line collector
// ---------------------------------------------------------------------------

function makeCollectingDeps(lines: string[]): CliDeps {
  return {
    env: process.env as Record<string, string | undefined>,
    fetchImpl: fetch,
    stdout: (line: string) => lines.push(line),
  };
}

async function collect(fn: (deps: CliDeps) => Promise<void>): Promise<string> {
  const lines: string[] = [];
  await fn(makeCollectingDeps(lines));
  return lines.join("\n") || "(no output)";
}

// ---------------------------------------------------------------------------
// runRepl
// ---------------------------------------------------------------------------

export async function runRepl(opts: { driver?: string; skill?: string } = {}): Promise<void> {
  // Local-or-daemon. In LOCAL mode we keep the in-process runtime handle so /tools
  // and /model still introspect the live host/driver (identical to before). In
  // DAEMON mode the runtime lives in the daemon, so those commands report that.
  const daemonUrl = process.env.TACHI_DAEMON_URL;
  let client: UnifiedClient;
  let banner: string;
  let listTools: () => string;
  let modelName: () => string;
  if (daemonUrl) {
    client = await createUnifiedClient(process.env);
    banner = `tachi-agent REPL · attached to daemon ${daemonUrl} · type /help, /exit`;
    listTools = () => "(unavailable — attached to a daemon)";
    modelName = () => "(daemon)";
  } else {
    const rt = await buildAgentFromEnv();
    client = localClient(rt);
    banner = `tachi-agent REPL · ${rt.driver.name} · ${rt.toolCount} tools · type /help, /exit`;
    listTools = () => rt.host.tools().map((t) => t.name).join("\n") || "(none)";
    modelName = () => rt.driver.name;
  }

  // Initial session from CLI flags; unknown --skill fails actionably up front.
  const skills = await loadSkills();
  const session: ChatSession = {};
  if (opts.driver) session.driver = opts.driver;
  if (opts.skill) {
    const skill = findSkill(skills, opts.skill);
    if (!skill) {
      await client.close();
      const names = skills.map((s) => s.name).join(", ") || "(none — add .md files under .tachi/skills)";
      throw new Error(`unknown skill "${opts.skill}" — available: ${names}`);
    }
    session.skill = skill;
  }

  const chatDeps: ChatDeps = {
    session,
    skills,
    listTools,
    modelName,
    mode: daemonUrl ? `daemon ${daemonUrl}` : "local",
    // Queue ops need the daemon; bind cli-commands fns only when it is configured.
    taskAdd: daemonUrl ? (text, o) => collect((d) => taskAdd(d, text, o)) : null,
    taskList: daemonUrl ? () => collect((d) => taskList(d)) : null,
    taskShow: daemonUrl ? (id) => collect((d) => taskShow(d, id)) : null,
    scheduleList: null, // no schedule-list surface in cli-commands yet — unified hint applies
  };

  console.error(banner);

  // Persistent input history (most-recent-first for readline).
  const histFile = historyFilePath();
  const history = await loadHistory(histFile);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: formatPrompt(session),
    history: [...history].reverse(),
  });

  const onEvent = (e: AgentEvent) => {
    if (e.type === "step") process.stderr.write(`  · step ${e.iteration}\n`);
    else if (e.type === "assistant" && e.toolCalls.length) process.stderr.write(`  🔧 ${e.toolCalls.map((c) => c.name).join(", ")}\n`);
    else if (e.type === "tool-result") process.stderr.write(`     ↳ ${e.name}\n`);
  };

  let active: AbortController | null = null;

  const runTurn = async (text: string): Promise<void> => {
    active = new AbortController();
    rl.pause();
    try {
      // Centralized precedence: session.driver > skill.driver (resolveRunOptions).
      const res = await client.run(text, {
        signal: active.signal,
        onEvent,
        ...resolveRunOptions(session),
      });
      console.log("\n" + res.answer + "\n");
    } catch (e) {
      console.error(`✖ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      active = null;
      rl.resume();
    }
  };

  rl.prompt();
  rl.on("line", (line) => {
    void (async () => {
      const trimmed = line.trim();
      if (trimmed && history[history.length - 1] !== trimmed) history.push(trimmed);

      const action = await handleChatLine(line, chatDeps);
      switch (action.kind) {
        case "exit":
          rl.close();
          return;
        case "reply":
          if (action.text) console.log(action.text);
          break;
        case "run":
          // Transparency: echo the rewritten task before running it.
          process.stderr.write(`→ ${action.text}\n`);
          await runTurn(action.text);
          break;
        case "message":
          await runTurn(action.text);
          break;
      }
      rl.setPrompt(formatPrompt(session)); // /driver, /skill, /reset change the session
      rl.prompt();
    })().catch((e) => {
      console.error(`✖ ${e instanceof Error ? e.message : String(e)}`);
      rl.prompt();
    });
  });

  // Ctrl-C: abort the running turn if any, else exit.
  rl.on("SIGINT", () => {
    if (active) { active.abort(); process.stderr.write("\n⏹  stopped this turn.\n"); }
    else rl.close();
  });

  rl.on("close", () => {
    void (async () => {
      await saveHistory(history, histFile);
      await client.close();
      process.exit(0);
    })();
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runRepl().catch((e) => { console.error(e); process.exit(1); });
}
