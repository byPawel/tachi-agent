// src/coding-agents/preflight.ts
/**
 * Fail-closed preflight for external coding CLIs. Without this, a missing binary
 * or absent credential surfaces only as a full-timeout hang (codex exits 2 on
 * auth failure; the runner otherwise waits out the whole timeoutMs). We verify
 * the binary resolves and at least one credential source exists BEFORE spawning,
 * and return an actionable reason the MCP layer can hand back immediately.
 */
import { join } from "node:path";
// Type-only: no runtime import, so preflight stays free of the harness module.
import type { OpenRouterHarnessName } from "./openrouter-harness.js";

export interface PreflightDeps {
  env: NodeJS.ProcessEnv;
  hasBinary: (cmd: string) => Promise<boolean>;
  fileExists: (path: string) => Promise<boolean>;
  home?: string;
}

export interface PreflightResult {
  ok: boolean;
  reason?: string;
}

/**
 * Extra facts the caller already resolved. `openrouter` is one public agent
 * name over several local CLIs, so the failure text has to say WHICH harness
 * was probed — otherwise "openrouter CLI not found" points at the wrong binary
 * and the wrong *_CLI override.
 */
export interface PreflightContext {
  openRouterHarness?: OpenRouterHarnessName;
}

type Agent = "codex" | "grok" | "hermes" | "openrouter" | "gemini" | "claude";

const CRED_HINT: Record<Agent, string> = {
  codex: "set CODEX_API_KEY or OPENAI_API_KEY, or run `codex login`",
  grok: "set XAI_API_KEY (or GROK_API_KEY), or run `grok login`",
  hermes: "set OPENROUTER_API_KEY (or the provider key Hermes is configured for)",
  openrouter: "set OPENROUTER_API_KEY",
  gemini: "set GEMINI_API_KEY (or GOOGLE_API_KEY / GOOGLE_APPLICATION_CREDENTIALS), " +
    "or run `gemini` once to complete OAuth — install: npm i -g @google/gemini-cli",
  claude: "set ANTHROPIC_API_KEY, or sign in once via `claude` (login state lives under ~/.claude) — " +
    "install: npm i -g @anthropic-ai/claude-code",
};

async function hasCredential(agent: Agent, deps: PreflightDeps): Promise<boolean> {
  const env = deps.env;
  const home = deps.home ?? env.HOME ?? "";
  switch (agent) {
    case "codex":
      return Boolean(env.CODEX_API_KEY || env.OPENAI_API_KEY)
        || (home ? deps.fileExists(join(home, ".codex", "auth.json")) : false);
    case "grok":
      return Boolean(env.XAI_API_KEY || env.GROK_API_KEY)
        || (home ? deps.fileExists(join(home, ".grok", "auth.json")) : false);
    case "hermes":
      return Boolean(env.OPENROUTER_API_KEY || env.OPENAI_API_KEY || env.ANTHROPIC_API_KEY);
    case "openrouter":
      return Boolean(env.OPENROUTER_API_KEY);
    case "gemini":
      return Boolean(env.GEMINI_API_KEY || env.GOOGLE_API_KEY || env.GOOGLE_APPLICATION_CREDENTIALS)
        || (home ? deps.fileExists(join(home, ".gemini", "oauth_creds.json")) : false);
    case "claude":
      return Boolean(env.ANTHROPIC_API_KEY)
        || (home
          ? (await deps.fileExists(join(home, ".claude.json"))) || deps.fileExists(join(home, ".claude"))
          : false);
  }
}

/** Verify the worker CLI can run before we spawn it. Fail closed. */
export async function preflightCodingAgent(
  agent: Agent,
  command: string,
  deps: PreflightDeps,
  context: PreflightContext = {},
): Promise<PreflightResult> {
  // The credential rule is per-AGENT (openrouter always needs OPENROUTER_API_KEY,
  // whichever CLI drives it); only the label names the harness that was probed.
  const label = agent === "openrouter" && context.openRouterHarness
    ? `openrouter/${context.openRouterHarness}`
    : agent;
  if (!(await deps.hasBinary(command))) {
    return { ok: false, reason: `${label} CLI "${command}" not found on PATH — install it or set the *_CLI env override` };
  }
  if (!(await hasCredential(agent, deps))) {
    return { ok: false, reason: `${label} has no usable credential — ${CRED_HINT[agent]}` };
  }
  return { ok: true };
}
