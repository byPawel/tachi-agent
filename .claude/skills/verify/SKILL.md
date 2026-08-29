---
name: verify
description: Build/launch/drive recipe for verifying tachi-agent changes at their runtime surfaces (REPL, gateway, MCP server, setup wizard)
---

# Verifying tachi-agent

Build: `npm run build` (tsc → dist/). Bins run directly: `node dist/cli.js`, `node dist/frontends/{repl,gateway,mcp-server,telegram}.js`.

## Environment gotchas

- Default driver is `ollama` with default model `qwen2.5` — this machine has `qwen3:8b` instead, so set `OLLAMA_MODEL=qwen3:8b` (and `TACHI_DRIVER=ollama`) on every launch.
- No `DOKORO_CMD`/`TACHIBOT_CMD` in env → runtime starts with 0 tools, pure-LLM loop. Fine (and fast) for driving chat/continuity; runs answer in one step.
- `~/.tachi/.env` is loaded as defaults by every bin; `TACHI_ENV_FILE=<path>` redirects it. Reading `.env` files directly is denied by permission rules — check key *names* via python, never print values.

## Surfaces

- **REPL / chat** (chat is the default CLI command): drive in isolated tmux —
  `tmux -L tachi-verify new-session -d -s repl -x 120 -y 40 "OLLAMA_MODEL=qwen3:8b node dist/cli.js"`, then `send-keys` / `capture-pane`. Prompt is `tachi ›`; count prompt occurrences to detect answer completion. A qwen3:8b answer takes ~5–20s.
- **Gateway**: `GATEWAY_TOKEN=verify-tok GATEWAY_PORT=18787 node dist/frontends/gateway.js` (refuses to start without token). POST /runs returns `{"run_id": ...}` (not `id`), 202-style async; poll `GET /runs/<run_id>` until `status != "running"`.
- **MCP server**: raw stdio JSON-RPC works — spawn `node dist/frontends/mcp-server.js`, send `initialize` → `notifications/initialized` → `tools/list` / `tools/call` as newline-delimited JSON. See a past driver at scratchpad `drive-mcp.mjs` pattern.
- **Setup wizard**: `printf '<answers>\n' | TACHI_ENV_FILE=<scratch>/wizard.env node dist/cli.js setup` — EOF makes remaining prompts take defaults (service install defaults to no, safe). Gotcha: it `mkdir ~/.tachi` even when TACHI_ENV_FILE points elsewhere — `rmdir ~/.tachi` after if it didn't exist before.

## Flows worth driving

- Chat continuity: ask "Who created Linux?" then "What else did he create?" — referent resolves only if history flows. `/reset` then re-ask → model should ask who "he" is.
- Gateway history validation: bad role / non-array / >40 turns / >32KiB → 400 with a single shared error message.
