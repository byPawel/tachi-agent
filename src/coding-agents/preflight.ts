// src/coding-agents/preflight.ts
/**
 * Fail-closed preflight for external coding CLIs. Without this, a missing binary
 * or absent credential surfaces only as a full-timeout hang (codex exits 2 on
 * auth failure; the runner otherwise waits out the whole timeoutMs). We verify
 * the binary resolves and at least one credential source exists BEFORE spawning,
 * and return an actionable reason the MCP layer can hand back immediately.
 */
import { join } from "node:path";

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

type Agent = "codex" | "grok" | "hermes" | "openrouter";

const CRED_HINT: Record<Agent, string> = {
  codex: "set CODEX_API_KEY or OPENAI_API_KEY, or run `codex login`",
  grok: "set XAI_API_KEY (or GROK_API_KEY), or run `grok login`",
  hermes: "set OPENROUTER_API_KEY (or the provider key Hermes is configured for)",
  openrouter: "set OPENROUTER_API_KEY",
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
  }
}

/** Verify the worker CLI can run before we spawn it. Fail closed. */
export async function preflightCodingAgent(
  agent: Agent,
  command: string,
  deps: PreflightDeps,
): Promise<PreflightResult> {
  if (!(await deps.hasBinary(command))) {
    return { ok: false, reason: `${agent} CLI "${command}" not found on PATH — install it or set the *_CLI env override` };
  }
  if (!(await hasCredential(agent, deps))) {
    return { ok: false, reason: `${agent} has no usable credential — ${CRED_HINT[agent]}` };
  }
  return { ok: true };
}
