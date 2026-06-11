# Stack installer + setup wizard — design

**Date:** 2026-06-12
**Status:** approved (brainstormed interactively; user picked: install-everything prereqs, minimal+offers wizard, bash bootstrap + Node wizard)

## Goal

One-line install of the whole stack — tachi-agent + dokoro + tachibot-mcp — plus a
terminal wizard that gets a first-time user to a working agent in minutes:

```
curl -fsSL https://bypawel.github.io/tachi-agent/install.sh | sh
```

All three packages are already on npm (tachi-agent 0.4.0, dokoro 0.1.0,
tachibot-mcp 2.23.1), so the installer is a bootstrap, not a build.

## Components

### 1. `docs/install.sh` — POSIX bootstrap (served by GitHub Pages)

macOS + Linux; Windows prints "use WSL" and exits. Idempotent steps:

1. **Node ≥ 22** (dokoro's floor; covers tachi-agent's ≥ 20): if missing/old,
   install via Homebrew (macOS) or apt/dnf (Linux); `fnm` as the no-sudo fallback.
2. **Ollama**: if missing, install via brew or the official
   `https://ollama.com/install.sh`. Failure is NON-fatal — the wizard offers
   OpenRouter as the brain instead.
3. **`npm install -g tachi-agent dokoro tachibot-mcp`** — on EACCES, do not
   sudo; print the `~/.npm-global` prefix fix and retry guidance.
4. **Hand off to the wizard**: `tachi-agent setup < /dev/tty` (the redirect is
   required because `curl | sh` occupies stdin). `--no-wizard` flag or
   `TACHI_NO_WIZARD=1` skips it (CI / non-interactive).

Safety: `set -eu`, https only, never pipes to sudo, shellcheck-clean.

### 2. `tachi-agent setup` — terminal wizard (new `src/setup.ts`)

Same testability pattern as `doctor.ts`: a pure core over injected deps
(`prompt`, `stdout`, `env`, `fetchImpl`, fs read/write), so the whole flow is
unit-testable with scripted answers. Re-runnable: existing `~/.tachi/.env`
values become the presented defaults.

Flow (minimal + offers):

1. **Detect** — versions of the three packages, Ollama reachability, existing
   `~/.tachi/.env`.
2. **Pick a brain**:
   - `[1]` Local Ollama (default) — offer `ollama pull qwen2.5` if absent.
   - `[2]` OpenRouter — prompt for `OPENROUTER_API_KEY`, validate with a live
     `GET /api/v1/models` probe. Sets `TACHI_DRIVER=openrouter` AND
     `USE_OPENROUTER_GATEWAY=true` so ONE key powers both the agent brain and
     the whole tachibot council.
   - `[3]` Other cloud — paste any provider keys, Enter to skip each.
3. **Auto-wire** — write `~/.tachi/.env` (chmod 600, merge-preserving):
   `TACHI_DRIVER`, `TACHIBOT_CMD=tachibot`, `DOKORO_CMD=dokoro`, generated
   `GATEWAY_TOKEN` (crypto-random), any keys collected above.
4. **Offers** (each y/N, all skippable):
   - daemon service install (delegates to existing `service-install` with
     `--env-file ~/.tachi/.env`),
   - Telegram / Slack tokens,
   - print `claude mcp add` snippets for dokoro + tachibot-mcp.
5. **Finish** — run existing `doctor`; print `try: tachi-agent chat`.

### 3. Env bootstrap — `~/.tachi/.env` auto-load (enabler)

Discovery: the published bins read ONLY `process.env` (the repo's npm scripts
use `node --env-file=.env`, which the installed CLI doesn't). Without a loader
the wizard's file would be inert. So: a small `loadUserEnv()` (reuses
`parseEnvFile` from `service.ts`) applies `~/.tachi/.env` entries as
**defaults only** — never overriding real environment variables — called at
the top of each bin entry (cli, daemon, mcp-server, gateway, telegram, slack,
repl, swarm). `TACHI_ENV_FILE` overrides the path; missing file is a no-op.

## Testing

- Wizard + env bootstrap: vitest with injected deps (scripted prompt answers,
  mock fetch for key validation, in-memory fs) — env merge, flow branches,
  token generation, chmod.
- `install.sh`: shellcheck; manual smoke on macOS; non-interactive path
  (`TACHI_NO_WIZARD=1`) in a clean Ubuntu container when CI is wired.

## Out of scope (YAGNI)

Native Windows, Homebrew formula, uninstaller, version pinning, auto-publishing.

## Ship checklist

1. Commit + push to master → GitHub Pages serves `install.sh` (fixes the 404).
2. `npm publish` tachi-agent (0.5.0) so the npm-installed CLI has `setup` +
   env bootstrap. Until then install.sh detects a missing `setup` subcommand
   and prints manual steps.
