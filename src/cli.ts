#!/usr/bin/env node
/** CLI entry point — progress to stderr, final answer to stdout. No args opens chat. */
import { createUnifiedClient } from "./client/unified.js";
import type { AgentEvent } from "./types.js";
import { parseCliArgs, taskAdd, taskList, taskShow, runsLog, type CliDeps } from "./cli-commands.js";
import { resolveRunOptions, type ChatSession } from "./chat-commands.js";
import { loadSkills, findSkill } from "./skills.js";
import { runDoctor } from "./doctor.js";
import { runRepl } from "./frontends/repl.js";
import { serviceInstall, serviceUninstall, serviceStatus, type ServiceDeps } from "./service.js";
import { runSetup } from "./setup.js";
import { loadUserEnv } from "./env-bootstrap.js";
import { execFile as execFileCb, spawn } from "node:child_process";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

/** Real-process ServiceDeps: never-throwing launchctl exec, stdout/stderr split. */
function makeServiceDeps(): ServiceDeps {
  return {
    platform: process.platform,
    home: homedir(),
    env: process.env as Record<string, string | undefined>,
    uid: process.getuid?.() ?? 0,
    execPath: process.execPath,
    execFile: (cmd, args) =>
      new Promise((resolve) => {
        execFileCb(cmd, args, (err, stdout, stderr) => {
          const code = err
            ? typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === "number"
              ? ((err as unknown as { code: number }).code)
              : 1
            : 0;
          resolve({ code, stdout: String(stdout), stderr: String(stderr) });
        });
      }),
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
  };
}

async function main() {
  await loadUserEnv(); // ~/.tachi/.env as defaults — real env vars win
  const argv = process.argv.slice(2);
  const parsed = parseCliArgs(argv);

  // ---------------------------------------------------------------------------
  // setup — first-run wizard (writes ~/.tachi/.env, offers service install)
  // ---------------------------------------------------------------------------
  if (parsed.command === "setup") {
    const { createInterface } = await import("node:readline/promises");
    const { mkdir, writeFile, readFile, chmod } = await import("node:fs/promises");
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      await runSetup({
        env: process.env as Record<string, string | undefined>,
        home: homedir(),
        stdout: (line) => console.log(line),
        // EOF / closed stdin (piped, CI) → "" = accept the default for the rest.
        prompt: async (q) => {
          try {
            return await rl.question(q);
          } catch {
            return "";
          }
        },
        fetchImpl: fetch,
        readFile: (p) => readFile(p, "utf8"),
        writeFile: async (p, data, mode) => {
          await writeFile(p, data, { mode });
          await chmod(p, mode); // mode in writeFile only applies on create
        },
        mkdir: async (p) => {
          await mkdir(p, { recursive: true });
        },
        runCommand: (cmd, args) =>
          new Promise((resolve) => {
            const child = spawn(cmd, args, { stdio: "inherit" });
            child.on("close", (code) => resolve(code ?? 1));
            child.on("error", () => resolve(1));
          }),
        randomToken: () => randomBytes(32).toString("hex"),
        installService: (envFile) => serviceInstall(makeServiceDeps(), { envFile }),
        doctor: async () => {
          await runDoctor({
            env: process.env as Record<string, string | undefined>,
            fetchImpl: fetch,
            stdout: (line) => console.log(line),
            nodeVersion: process.version,
            loadSkills: () => loadSkills(),
          });
        },
      });
    } finally {
      rl.close();
    }
    return;
  }

  // -------------------------------------------------------------------------
  // Interactive chat (default with no args) — full REPL with /commands
  // -------------------------------------------------------------------------
  if (parsed.command === "chat") {
    await runRepl({ driver: parsed.driver, skill: parsed.skill });
    return;
  }

  // -------------------------------------------------------------------------
  // doctor — preflight diagnostics; exit 1 when a critical check fails
  // -------------------------------------------------------------------------
  if (parsed.command === "doctor") {
    const { ok } = await runDoctor({
      env: process.env as Record<string, string | undefined>,
      fetchImpl: fetch,
      stdout: (line) => console.log(line),
      nodeVersion: process.version,
      loadSkills: () => loadSkills(),
    });
    process.exit(ok ? 0 : 1);
  }

  // -------------------------------------------------------------------------
  // service install / uninstall / status — launchd daemon autostart (macOS)
  // -------------------------------------------------------------------------
  if (parsed.command.startsWith("service-")) {
    if (parsed.command === "service-help") {
      console.error("Usage: tachi-agent service install [--env-file <path>] [--cwd <dir>] | uninstall | status");
      process.exit(1);
    }
    const deps = makeServiceDeps();
    switch (parsed.command) {
      case "service-install":
        await serviceInstall(deps, { envFile: parsed.envFile, cwd: parsed.cwd });
        break;
      case "service-uninstall":
        await serviceUninstall(deps);
        break;
      case "service-status":
        await serviceStatus(deps);
        break;
    }
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
