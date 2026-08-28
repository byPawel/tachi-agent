/**
 * tachi-agent doctor — preflight diagnostics. Checks the local setup and
 * prints one ✓/✖/– line per check; exits non-zero when a CRITICAL check
 * fails. Pure: all IO via injected deps so every check is unit-testable.
 *
 * Checks: node version, Ollama reachability + model presence, TACHI_DRIVER
 * resolution, tachibot/dokoro MCP wiring, skills directory, daemon gateway,
 * coding-agent worker CLIs (informational).
 */
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";

import "./drivers/register.js"; // side-effect: registers the built-in drivers
import { preflightCodingAgent, type PreflightDeps } from "./coding-agents/preflight.js";
import { getDriver } from "./registry.js";

export interface DoctorDeps {
  env: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
  stdout: (line: string) => void;
  nodeVersion: string; // process.version
  loadSkills: () => Promise<{ name: string }[]>;
}

/** ok:true → ✓, ok:false → ✖, ok:null → – (informational/skipped). */
export interface CheckResult {
  name: string;
  ok: boolean | null;
  detail: string;
  critical: boolean;
}

const PROBE_TIMEOUT_MS = 3_000;

/** GET with a hard timeout — doctor probes must never hang the CLI. */
async function probe(
  fetchImpl: typeof fetch,
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

function checkNode(deps: DoctorDeps): CheckResult {
  const major = parseInt(deps.nodeVersion.replace(/^v/, ""), 10);
  if (Number.isFinite(major) && major >= 20) {
    return { name: "node", ok: true, detail: deps.nodeVersion, critical: true };
  }
  return {
    name: "node",
    ok: false,
    detail: `${deps.nodeVersion} — tachi-agent needs Node >= 20`,
    critical: true,
  };
}

async function checkOllama(deps: DoctorDeps): Promise<CheckResult> {
  const driverName = deps.env.TACHI_DRIVER?.trim();
  if (driverName && driverName !== "ollama") {
    return {
      name: "ollama",
      ok: null,
      detail: `skipped (TACHI_DRIVER=${driverName})`,
      critical: false,
    };
  }

  const base = (deps.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
  const model = deps.env.OLLAMA_MODEL ?? "qwen2.5";

  let res: Response;
  try {
    res = await probe(deps.fetchImpl, `${base}/api/tags`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch {
    return {
      name: "ollama",
      ok: false,
      detail: `unreachable at ${base} — start: ollama serve`,
      critical: true,
    };
  }

  const data = (await res.json().catch(() => ({}))) as { models?: { name: string }[] };
  const want = model.split(":")[0];
  const present = (data.models ?? []).some((m) => m.name.split(":")[0] === want);
  if (!present) {
    return {
      name: "ollama",
      ok: false,
      detail: `reachable, but model "${model}" is missing — run: ollama pull ${model}`,
      critical: false,
    };
  }
  return {
    name: "ollama",
    ok: true,
    detail: `reachable at ${base}, model ${model} present`,
    critical: false,
  };
}

function checkDriver(deps: DoctorDeps): CheckResult {
  const name = deps.env.TACHI_DRIVER?.trim() || "ollama";
  try {
    // getDriver constructs; cloud factories throw an actionable message when
    // their API key is missing, and unknown names list the registered drivers.
    const driver = getDriver(name);
    return { name: "driver", ok: true, detail: `${name} → ${driver.name}`, critical: true };
  } catch (e) {
    return {
      name: "driver",
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
      critical: true,
    };
  }
}

function checkMcpServer(
  name: string,
  cmd: string | undefined,
  missingDetail: string,
): CheckResult {
  if (cmd && cmd.trim()) {
    return { name, ok: true, detail: `configured: ${cmd.trim()}`, critical: false };
  }
  return { name, ok: false, detail: missingDetail, critical: false };
}

async function checkSkills(deps: DoctorDeps): Promise<CheckResult> {
  const skills = await deps.loadSkills();
  if (skills.length === 0) {
    return { name: "skills", ok: null, detail: "none found (.tachi/skills)", critical: false };
  }
  const names = skills.map((s) => s.name).join(", ");
  return {
    name: "skills",
    ok: true,
    detail: `${skills.length} skill(s): ${names}`,
    critical: false,
  };
}

async function checkDaemon(deps: DoctorDeps): Promise<CheckResult> {
  const rawUrl = deps.env.TACHI_DAEMON_URL;
  if (!rawUrl || !rawUrl.trim()) {
    return { name: "daemon", ok: null, detail: "local mode (no TACHI_DAEMON_URL)", critical: false };
  }
  const base = rawUrl.trim().replace(/\/+$/, "");

  const token = deps.env.GATEWAY_TOKEN;
  if (!token) {
    return {
      name: "daemon",
      ok: false,
      detail: "GATEWAY_TOKEN unset — required with TACHI_DAEMON_URL (set GATEWAY_TOKEN)",
      critical: true,
    };
  }

  let res: Response;
  try {
    res = await probe(deps.fetchImpl, `${base}/tasks`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    return { name: "daemon", ok: false, detail: `unreachable at ${base}`, critical: true };
  }

  if (res.status === 401) {
    return { name: "daemon", ok: false, detail: "token rejected (check GATEWAY_TOKEN)", critical: true };
  }
  if (!res.ok) {
    return { name: "daemon", ok: false, detail: `HTTP ${res.status} from ${base}/tasks`, critical: true };
  }
  const data = (await res.json().catch(() => ({}))) as { tasks?: unknown[] };
  return {
    name: "daemon",
    ok: true,
    detail: `reachable, ${data.tasks?.length ?? 0} task(s)`,
    critical: false,
  };
}

const CODING_AGENTS = ["codex", "grok", "hermes", "openrouter"] as const;

function agentCommand(agent: string, env: Record<string, string | undefined>): string {
  const key = agent === "openrouter" ? "HERMES_CLI" : `${agent.toUpperCase()}_CLI`;
  return env[key]?.trim() || (agent === "openrouter" ? "hermes" : agent);
}

/**
 * One informational line per coding-agent worker CLI. Probes the agents in
 * TACHI_CODING_AGENTS (comma list); with none set, probes all known agents
 * with ok:null so an absent worker never reads as a failure. Never critical:
 * a broken worker must not flip the doctor's exit code.
 */
export async function checkCodingAgents(deps: DoctorDeps): Promise<CheckResult[]> {
  const configured = deps.env.TACHI_CODING_AGENTS?.split(",").map((s) => s.trim()).filter(Boolean);
  const agents = configured?.length ? configured : [...CODING_AGENTS];
  const pfDeps = (env: Record<string, string | undefined>): PreflightDeps => ({
    env: env as NodeJS.ProcessEnv,
    hasBinary: async (cmd) => new Promise<boolean>((resolve) => {
      // Shell-free: on POSIX `command -v` is a builtin, so invoke sh but pass
      // cmd as the positional $1 (never interpolated → no injection surface).
      if (process.platform === "win32") {
        execFile("where", [cmd], (err) => resolve(!err));
      } else {
        execFile("/bin/sh", ["-c", 'command -v -- "$1" >/dev/null 2>&1', "sh", cmd], (err) => resolve(!err));
      }
    }),
    fileExists: async (p) => { try { await access(p); return true; } catch { return false; } },
  });
  const out: CheckResult[] = [];
  for (const agent of agents) {
    if (!CODING_AGENTS.includes(agent as typeof CODING_AGENTS[number])) continue;
    const cmd = agentCommand(agent, deps.env);
    const pf = await preflightCodingAgent(agent as typeof CODING_AGENTS[number], cmd, pfDeps(deps.env));
    out.push({
      name: `coding:${agent}`,
      ok: pf.ok ? true : (configured ? false : null),
      detail: pf.ok ? `ready (${cmd})` : (pf.reason ?? "not configured"),
      critical: false,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// runDoctor
// ---------------------------------------------------------------------------

/**
 * Run all checks, print one aligned line per check + a footer, and return
 * the results. `ok` is false iff any CRITICAL check failed (non-critical
 * failures are counted in the footer but do not flip the exit code).
 */
export async function runDoctor(deps: DoctorDeps): Promise<{ results: CheckResult[]; ok: boolean }> {
  const results: CheckResult[] = [
    checkNode(deps),
    await checkOllama(deps),
    checkDriver(deps),
    checkMcpServer(
      "tachibot",
      deps.env.TACHIBOT_CMD,
      "unset — council tools unavailable (set TACHIBOT_CMD)",
    ),
    checkMcpServer(
      "dokoro",
      deps.env.DOKORO_CMD,
      "unset — memory disabled (set DOKORO_CMD)",
    ),
    await checkSkills(deps),
    await checkDaemon(deps),
    ...(await checkCodingAgents(deps)),
  ];

  const nameWidth = Math.max(...results.map((r) => r.name.length)) + 2;
  for (const r of results) {
    const symbol = r.ok === true ? "✓" : r.ok === false ? "✖" : "–";
    deps.stdout(`${symbol} ${r.name.padEnd(nameWidth)}${r.detail}`);
  }

  const problems = results.filter((r) => r.ok === false).length;
  deps.stdout(problems === 0 ? "doctor: all good" : `doctor: ${problems} problem(s) found`);

  const ok = !results.some((r) => r.ok === false && r.critical);
  return { results, ok };
}
