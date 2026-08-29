/**
 * Minimal per-agent child environment. Spawning a third-party CLI with the full
 * inherited process.env exposes every developer secret (gateway bearer tokens,
 * cloud keys, DB URLs) to a cloud-connected binary that may log or transmit them.
 * Workers get PATH/HOME-class basics plus ONLY the credentials their own agent
 * needs. Extend per-machine with TACHI_WORKER_ENV_ALLOW when a specific worker
 * legitimately needs another variable.
 */
export type WorkerAgentName = "codex" | "grok" | "hermes" | "openrouter";

/** OS/runtime basics every CLI needs to function. Never secrets. */
const BASE_ALLOW = [
  "PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SHELL", "USER", "LOGNAME",
  "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TERMINFO", "TZ", "COLUMNS", "LINES",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "NODE_OPTIONS",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NO_COLOR", "FORCE_COLOR",
];

/** Credential + config keys each agent's CLI legitimately reads. */
const AGENT_ALLOW: Record<WorkerAgentName, string[]> = {
  codex: ["CODEX_API_KEY", "OPENAI_API_KEY", "CODEX_HOME"],
  grok: ["XAI_API_KEY", "GROK_API_KEY", "GROK_HOME"],
  hermes: ["HERMES_CLI", "OPENROUTER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "TACHI_OPENROUTER_CODING_MODEL", "OPENROUTER_MODEL"],
  openrouter: ["HERMES_CLI", "OPENROUTER_API_KEY", "TACHI_OPENROUTER_CODING_MODEL", "OPENROUTER_MODEL"],
};

function extraAllow(baseEnv: NodeJS.ProcessEnv): string[] {
  const raw = baseEnv.TACHI_WORKER_ENV_ALLOW;
  return raw ? raw.split(",").map((k) => k.trim()).filter(Boolean) : [];
}

/** Build a minimal env for `agent`, copied from `baseEnv` (never mutated). */
export function buildWorkerEnv(
  agent: WorkerAgentName,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const allow = new Set([...BASE_ALLOW, ...AGENT_ALLOW[agent], ...extraAllow(baseEnv)]);
  const out: NodeJS.ProcessEnv = {};
  for (const key of allow) {
    const v = baseEnv[key];
    if (typeof v === "string" && v !== "") out[key] = v;
  }
  // Recursion marker: the allowlist strips Claude Code's own CLAUDECODE
  // nested-launch brake, so this stamp replaces it — the MCP handler refuses
  // to spawn workers when its own env already carries it. Set after the copy
  // loop so no inherited/allowlisted value can override it.
  out.TACHI_CODING_DEPTH = "1";
  return out;
}
