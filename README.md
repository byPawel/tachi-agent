# tachi-agent

A **local-first orchestration agent** — a small, pluggable ReAct hub that fuses
**dokoro** (persistent memory) with **tachibot** (multi-model council) over MCP.
Its default brain runs **100% local** (Qwen2.5 via Ollama), so judgment-grade
multi-model reasoning works offline at zero token cost.

> Design thesis: *gateways route calls; tachibot routes thinking; tachi-agent is
> where memory (dokoro) and orchestration (tachibot) finally fuse.* The agent loop
> lives in the **client**, never inside an MCP server (nesting a loop in a server
> is a 2026 anti-pattern).

## Architecture

```
   OpenClaw · Slack · Claude Code (MCP) · CLI        ← front-ends: call orchestrator.run(task)
                     │
                     ▼
   ┌──────────── Orchestrator (the hub) ────────────┐
   │  dokoro.recall → ReAct loop → dokoro.log         │
   │  HALT @ maxIterations + wall-clock timeout       │
   │  depends on TWO injected seams ↓↓                │
   └──────┬──────────────────────────────┬───────────┘
          │ Driver (the brain)            │ ToolHost (the tools)
          ▼                                ▼
   default: Qwen2.5 / Ollama        merged MCP tools, namespaced:
   (OpenClaw/cloud can swap in)      dokoro_*  +  tachibot_*
```

### The seams (this is the whole API — see `src/types.ts`)

| Seam | Swap it to… | Default |
|---|---|---|
| **`Driver`** | change the brain (OpenClaw's model, a cloud model, Kimi swarm) | local **Qwen2.5/Ollama** |
| **`ToolHost`** | add/remove MCP servers & tools (config, not code) | **dokoro** + **tachibot** merged, namespaced `${server}_${tool}` |
| **`Memory`** | swap or disable persistent context | **dokoro** session recall/log |

Because the core depends only on these interfaces, **every integration composes
the same hub without touching it**:

- **Tools auto-appear** from whatever MCP servers are connected — `tachibot_jury`,
  `tachibot_council`, `tachibot_grok_search`, `tachibot_perplexity_ask`,
  `tachibot_nextThought` (thinking), `tachibot_execute_prompt_technique` (prompt
  workflows), `tachibot_workflow` (YAML workflows), `dokoro_session_recall`, … —
  all **config, not code**.
- **Front-ends** (CLI, Slack, Claude Code via an MCP `run_agent` tool, OpenClaw)
  just call `orchestrator.run(task)`.
- **Swarm** is a future *composition* of the unit (N agents → synthesize via
  `tachibot_council`), not a change to it.

## Roadmap (build the unit, then multiply)

- **L0 — core** ✅ `Orchestrator` + seams + tests (this commit). Brain/tools/memory all faked in tests; no network needed.
- **L1 — adapters** ⏳ `OllamaDriver` (Qwen2.5, native `/api/chat`), `McpToolHost` (dokoro + tachibot over stdio, namespaced), `DokoroMemory`, a `cli` front-end.
- **L2 — front-ends** ⏳ Slack bot; Claude Code via a thin `run_agent` MCP server; OpenClaw driver.
- **L3 — swarm** ⏳ separate package: fan out N agents (varied roles/drivers, incl. Kimi swarm) → `tachibot_council` synthesis (a `deep-research`-shaped flow).

## Develop

```bash
npm install
npm test       # vitest — core orchestrator, fully mocked
npm run build  # tsc → dist/
```

## Extending (without forking)

```ts
import { createOrchestrator, registerDriver } from "tachi-agent";

// 1. plug in any brain (OpenClaw, a cloud model, a Kimi-swarm driver)
registerDriver("openclaw", () => new OpenClawDriver());

// 2. build the hub from a registered name (or a raw Driver instance)
const agent = createOrchestrator({ driver: "openclaw", host, memory });

// 3. run — and stop it any time
const controller = new AbortController();
const result = await createOrchestrator({
  driver: "openclaw", host, memory,
  options: { maxIterations: 12, timeoutMs: 90_000, signal: controller.signal },
}).run("verify HEAD against ADR-1..3");
// elsewhere: controller.abort()  → run halts with haltedBy: "aborted"
```

Implement `Driver` / `ToolHost` / `Memory` (see `src/types.ts`) to extend; no core changes.

## Why MIT (not AGPL)

tachi-agent is the **pluggable hub meant to be embedded** by other agents — adoption
beats protection here, and AGPL would scare off the embedders. The moat lives
*elsewhere* (dokoro context + tachibot's cross-vendor council it calls), both of
which it reaches over the MCP wire, so an MIT client and an AGPL `tachibot-mcp`
server coexist cleanly.

License: MIT
