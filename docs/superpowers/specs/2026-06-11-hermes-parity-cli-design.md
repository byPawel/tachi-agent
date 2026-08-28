# Hermes-parity CLI + chat control — design (v0.4.0)

**Goal:** `tachi-agent` works like a polished terminal agent (hermes-style): interactive chat by default, one-command background daemon on macOS, a unified chat-command surface shared by terminal and Telegram, and file-based skill bundles. Cross-platform except the launchd-specific `service` subcommand.

**User decisions (locked):** chat-by-default UX; `service install` macOS-only v1 (Linux = systemd template in README); Telegram gets ALL of: bot commands, queue/schedule control, driver switching, skill bundles; unified command layer across frontends; terminal chat controls (history, turn abort).

## Components

### 1. Skills core — `src/skills.ts` (foundation, cross-platform)
- Loads `.tachi/skills/*.md` (override dir: `TACHI_SKILLS_DIR`). Frontmatter: `name` (required, kebab), `description`, `tools` (optional allowlist of namespaced tool names), `driver` (optional registered driver name). Body = extra system prompt appended to the run's `systemPrompt`.
- API: `loadSkills(dir?): Promise<Skill[]>`, `findSkill(skills, name)`. Malformed files: skip with stderr warn (fail-soft, same as schedules).
- Orchestrator addition: `OrchestratorOptions.allowTools?: string[]` — filters `host.tools()` for THIS run only (fail-closed: names that don't match expose nothing extra). One-line filter at the top of `run()`; dispatch already validates against the filtered list.

### 2. Driver/skill pass-through (multiheart plumbing)
- `UnifiedClient.run(task, opts)` gains optional `driver?: string`, plus `systemPrompt`/`allowTools` already-supported-locally options flowing through:
  - local mode: `runtime.orchestrator(options, driver)` (exists since v0.3.0).
  - daemon mode: `POST /runs` body gains optional `driver` (string, validated like /tasks), `systemPrompt` (string, capped at 16 KiB), `allowTools` (string[], each entry validated, max 64 entries). Gateway passes them into orchestrator options. Authed surface; caps prevent abuse.

### 3. Unified chat commands — `src/chat-commands.ts`
- One parser + executor consumed by BOTH the REPL and Telegram. `parseChatCommand(line)` → typed command; `executeChatCommand(cmd, ctx)` → reply text (or `null` = treat as plain agent message).
- Context (`ChatCtx`) is injected: `{ client, session, env, skills, listTools, modelName, stdoutLimit }` where `session = { driver?: string; skill?: Skill }` (per-REPL-process / per-Telegram-chat).
- Commands: `/help`, `/tools`, `/model`, `/status` (daemon URL or local + current driver/skill), `/driver <name>|off`, `/skill <name>|off`, `/jury <q>`, `/search <q>`, `/think <q>` (explicit-tool task phrasing → works local AND daemon-attached), `/task add|list|show` and `/schedule list` (reuse `cli-commands.ts` functions; "needs a daemon" hint in local mode).
- Plain messages run through the agent with the session's driver/skill applied.
- Driver precedence (explicit and documented): session `/driver` choice > the active skill's `driver` field > `TACHI_DRIVER` env default. Same rule for CLI flags: `--driver` > `--skill`'s driver > env.

### 4. CLI chat-by-default + flags — `src/cli.ts`, `src/frontends/repl.ts`
- `parseCliArgs`: empty argv → `{command: "chat"}`; new flags `--driver <name>` and `--skill <name>` valid on both chat and one-shot run.
- `repl.ts`: extract `main()` → exported `runRepl(opts?: { driver?: string; skill?: string })`; cli dispatches chat to it. `tachi-agent-repl` bin unchanged.
- REPL swaps its private command handling for the unified layer; adds persistent readline history at `~/.tachi-agent/repl_history` (cap 1000 lines, fail-soft on IO errors).

### 5. `service` subcommand (macOS launchd) — `src/service.ts`
- `tachi-agent service install [--env-file <path>] [--cwd <dir>] [--port <n>]`, `service uninstall`, `service status`.
- Plist `~/Library/LaunchAgents/com.tachi-agent.daemon.plist`: `ProgramArguments = [process.execPath (ABSOLUTE node — survives nvm/volta), <abs path to installed dist/daemon/index.js>]`; `EnvironmentVariables` parsed from `--env-file` (required if `GATEWAY_TOKEN` not in current env — daemon refuses to start without auth); `WorkingDirectory` default `~/.tachi-agent/` (created; `.tachi/` state lives there); `RunAtLoad`+`KeepAlive`; stdout/err → `~/Library/Logs/tachi-agent/daemon.log`.
- install = write plist + `launchctl bootstrap gui/<uid> <plist>` (fallback `launchctl load -w` on older macOS); uninstall = `bootout` + rm; status = `launchctl print gui/<uid>/com.tachi-agent.daemon` (exit code + parsed state line).
- Pure plist/env generation is exported and unit-tested; only the `launchctl` execs are thin untested shells. Non-macOS: actionable error pointing at the README systemd template.

### 6. Telegram upgrade — `src/frontends/telegram.ts`
- Before the normal run flow: if text starts with `/`, parse via the unified layer with the chat's session (in-memory `Map<chatId, Session>`); reply with the command result. Long replies truncated to Telegram limits (existing helpers).
- Plain messages: run with session driver/skill, exactly like today otherwise (status-edit streaming preserved).

## Error handling
Everything user-facing fails actionable and soft: unknown driver → registry error text (existing); unknown skill → list available; service on Linux → README pointer; daemon-only commands in local mode → hint. Nothing new throws into the agent loop.

## Testing
TDD throughout, existing patterns: pure helpers exported; injected `env`/`fetchImpl`/`now`/fs temp dirs; no network. New test files per module (`skills`, `chat-commands`, `service` plist generation, gateway pass-through, telegram command routing). launchctl execs and readline wiring are smoke-tested manually.

## Out of scope
Linux systemd subcommand (template only), skill marketplace/sharing, persistent per-chat sessions across daemon restarts, Slack parity (follow-up — the unified layer makes it cheap).

## Sequencing
Wave A (foundation): skills.ts + allowTools + driver/skill pass-through (gateway + unified client).
Wave B (parallel): chat-commands + REPL/CLI rewire ∥ service.ts ∥ telegram (telegram starts after chat-commands lands — same-wave pipeline).
Wave C: README + docs site + version bump to 0.4.0; announce-ready.
