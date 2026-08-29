# OpenRouter Coding Adapter Design

**Date:** 2026-08-29

**Status:** Approved direction

## Objective

Keep `run_coding_agent({ agent: "openrouter" })` as Tachi's single public path for arbitrary OpenRouter models while making the coding harness behind that path replaceable. Preserve native `codex`, `grok`, `gemini`, `claude`, and `hermes` workers for capabilities that only their vendor runtimes provide.

## Product Boundary

Tachi owns cross-agent orchestration: one MCP contract, root allowlists, write authorization, process limits, cancellation, progress events, worktree policy, Dokoro leases, and directed handoffs. It does not become another vendor-specific coding agent and does not expose the selected OpenRouter harness in the MCP schema.

OpenRouter is the generic model lane. Chinese-origin and open models such as GLM, Kimi, DeepSeek, and Qwen enter through this lane without new `CodingAgentName` variants or vendor-specific runners.

## Architecture

```text
MCP caller
  -> run_coding_agent(agent="openrouter", model=...)
  -> existing Tachi security and coordination gates
  -> OpenRouter harness adapter
       -> Hermes harness (current baseline)
       -> Codex CLI harness configured for OpenRouter (candidate)
  -> OpenRouter provider/model
  -> normalized CodingAgentResult + Dokoro handoff
```

The public `agent: "openrouter"` value, input schema, result identity, and Dokoro behavior remain unchanged. `TACHI_OPENROUTER_HARNESS=hermes|codex` selects the private harness. The initial default remains `hermes` until the live comparison defined in the implementation plan is complete.

## Harness Contract

The adapter receives the normalized task, resolved working directory, selected model, review/write mode, isolation preference, maximum turns, timeout, and sanitized parent environment. It returns a shell-free `CodingAgentCommand` plus metadata declaring its output format and workspace isolation strategy.

Harness metadata must be sufficient for the runner to:

- choose the correct output parser and live-event decoder;
- report whether the requested checkout or a disposable worktree was used;
- run the correct binary and credential preflight;
- preserve the external identity as `openrouter/<model>`.

## Security Requirements

- Review is safe by default. Hermes review keeps its forced worktree. Codex review uses Codex's `read-only` sandbox.
- Write remains gated by `TACHI_CODING_ALLOW_WRITE=1` before harness selection.
- Tasks remain positional arguments with no shell interpolation and retain the leading-dash rejection.
- Workers receive only OS basics, `OPENROUTER_API_KEY`, model hints, recursion marker, and the harness binary/config variables. *(Amended 2026-08-29: the implementation uses one static union allowlist for the `openrouter` lane — both harnesses' binary variables are forwarded regardless of the selected harness. The selector is read from the environment at spawn time, a static per-harness split would complicate `buildWorkerEnv` for no secret-exposure benefit — `HERMES_CLI`/`CODEX_CLI`/`CODEX_HOME`/`OPENROUTER_BASE_URL` are paths and URLs, not credentials — and the plan's Task 2 prescribed the union explicitly. Cross-review flagged the mismatch; the spec wording, not the code, was wrong.)*
- `TACHI_CODING_DEPTH=1`, timeout process-tree termination, root allowlists, concurrency caps, Dokoro leases, and result-size limits remain unchanged.
- A missing or invalid harness value fails closed with an actionable error.
- No API key value is written to repository files or command arguments.

## Codex-over-OpenRouter Candidate

The Codex candidate invokes `codex exec --ephemeral --json` and supplies OpenRouter through per-process Codex configuration overrides. It preserves Codex JSONL progress, command/file/tool events, sandbox selection, and final-answer parsing. It authenticates from the sanitized `OPENROUTER_API_KEY` environment.

The candidate does not reuse native Codex login state and does not change `~/.codex/config.toml`. Its configuration is local to the spawned process so Tachi's OpenRouter worker behaves consistently across caller machines.

## Selection Policy

Hermes is the baseline and remains the default while both harnesses are evaluated with the same model and fixtures. Codex becomes the default only if it:

1. passes all contract and security tests;
2. completes every write fixture with the expected tests green;
3. produces no mutation in review fixtures;
4. provides at least the same successful-run rate as Hermes;
5. provides structured trace events without exposing private chain-of-thought.

If Codex fails any hard gate, Hermes stays the default. After one harness is selected and has completed a release cycle without a harness-specific regression, remove the losing implementation and the temporary selector in a separate cleanup change. The MCP contract does not change during that cleanup.

## Non-Goals

- Replacing native vendor workers with OpenRouter models.
- Adopting `@openrouter/agent` inside the existing Tachi ReAct loop.
- Adding one worker type per model vendor.
- Automatic model selection or benchmark-based routing in this change.
- Changing the existing standalone `TACHI_DRIVER=openrouter` inference driver.
- Persisting provider credentials in Codex or Tachi configuration files.

## Acceptance Criteria

- Existing callers continue using `agent: "openrouter"` without schema changes.
- Both harness implementations satisfy the same unit-test contract.
- `doctor` names the selected harness and checks its actual binary plus OpenRouter credential.
- Codex-backed runs expose normalized Codex trace events for `trace` and `live` visibility.
- README documents the selector, default, security behavior, and evaluation command.
- The full test suite and TypeScript build pass.

