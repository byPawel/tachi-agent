/**
 * tachi-agent setup — first-run terminal wizard. Gets a fresh install to a
 * working agent: pick a brain (local Ollama / OpenRouter / other cloud), wire
 * dokoro + tachibot-mcp, write ~/.tachi/.env (chmod 600), then optional
 * offers (daemon service, Telegram/Slack, Claude Code snippets) and doctor.
 *
 * Pure core over injected deps (same discipline as doctor.ts/service.ts) so
 * every flow branch is unit-testable with scripted answers. Re-runnable:
 * existing env-file values are preserved and become the presented defaults.
 */
import { parseEnvFile } from "./service.js";

export interface SetupDeps {
  env: Record<string, string | undefined>;
  home: string;
  stdout: (line: string) => void;
  /** Ask one question, return the raw line ("" = accept default). */
  prompt: (question: string) => Promise<string>;
  fetchImpl: typeof fetch;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, data: string, mode: number) => Promise<void>;
  mkdir: (path: string) => Promise<void>;
  /** Run a command with inherited stdio (e.g. `ollama pull`); resolves exit code. */
  runCommand: (cmd: string, args: string[]) => Promise<number>;
  /** Crypto-random token for GATEWAY_TOKEN. */
  randomToken: () => string;
  /** Delegates to the existing service-install path. */
  installService: (envFile: string) => Promise<void>;
  /** Runs the existing doctor checks. */
  doctor: () => Promise<void>;
  /**
   * Keys that loadUserEnv() applied to `env` at bin startup (i.e. values that
   * came from the env FILE, not the shell). After the wizard rewrites the file,
   * these are refreshed in `env` so the same-process doctor run sees the new
   * config; keys NOT listed here are real env vars and still win.
   */
  envFileKeys?: string[];
}

const PROBE_TIMEOUT_MS = 3_000;
const OLLAMA_URL = "http://localhost:11434";
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

/** Provider keys offered in the "more council keys" loop (tachibot-mcp names). */
const EXTRA_KEYS = [
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "XAI_API_KEY",
  "PERPLEXITY_API_KEY",
  "QWEN_API_KEY",
] as const;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Serialize an env record: header comment, sorted keys. Values are written
 * raw (parseEnvFile takes everything after `=`, so spaces and inner quotes
 * survive); quoting only when the value would be mangled — leading/trailing
 * whitespace (parse trims) or a surrounding-quote lookalike (parse strips).
 * The dotenv format is line-based, so newlines in a value are collapsed to
 * spaces — a raw `\n` would otherwise inject phantom KEY=VALUE lines.
 */
export function serializeEnvFile(entries: Record<string, string>): string {
  const lines = [
    "# ~/.tachi/.env — managed by `tachi-agent setup` (re-run anytime).",
    "# Loaded as DEFAULTS by tachi-agent bins; real env vars always win.",
  ];
  for (const key of Object.keys(entries).sort()) {
    const v = entries[key].replace(/[\r\n]+/g, " ");
    const fragile = v === "" || /^\s|\s$/.test(v) || /^(".*")$|^('.*')$/.test(v);
    const quoted = fragile ? (v.includes('"') ? `'${v}'` : `"${v}"`) : v;
    lines.push(`${key}=${quoted}`);
  }
  return lines.join("\n") + "\n";
}

/** Mask a secret for display: first 8 chars + ellipsis. */
function mask(v: string): string {
  return v.length > 11 ? `${v.slice(0, 8)}…` : "(set)";
}

async function probe(deps: SetupDeps, url: string, headers?: Record<string, string>) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    return await deps.fetchImpl(url, { headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function ask(deps: SetupDeps, question: string, def: string): Promise<string> {
  const suffix = def ? ` [${def}]` : "";
  const answer = (await deps.prompt(`${question}${suffix}: `)).trim();
  return answer || def;
}

async function yesNo(deps: SetupDeps, question: string, def = false): Promise<boolean> {
  const answer = (await deps.prompt(`${question} ${def ? "[Y/n]" : "[y/N]"}: `)).trim();
  if (!answer) return def;
  return /^y(es)?$/i.test(answer);
}

// ---------------------------------------------------------------------------
// Wizard steps
// ---------------------------------------------------------------------------

async function pickBrain(deps: SetupDeps, file: Record<string, string>): Promise<void> {
  const current = file.TACHI_DRIVER || "ollama";
  deps.stdout("");
  deps.stdout("Pick your brain (the model that drives the agent loop):");
  deps.stdout("  [1] Local Ollama — 100% local, free (default)");
  deps.stdout("  [2] OpenRouter — one API key unlocks the agent AND the tachibot council");
  deps.stdout("  [3] Other / configure keys manually");
  const choice = await ask(deps, "Choice", current === "openrouter" ? "2" : "1");

  if (choice === "2" || choice.toLowerCase() === "openrouter") {
    await setupOpenRouter(deps, file);
    return;
  }
  if (choice === "3") {
    file.TACHI_DRIVER = file.TACHI_DRIVER || "ollama";
    deps.stdout("Keeping driver = " + file.TACHI_DRIVER + " — add provider keys next.");
    return;
  }
  await setupOllama(deps, file);
}

async function setupOllama(deps: SetupDeps, file: Record<string, string>): Promise<void> {
  file.TACHI_DRIVER = "ollama";
  const model = file.OLLAMA_MODEL || deps.env.OLLAMA_MODEL || "qwen2.5";
  let up = false;
  let hasModel = false;
  try {
    const res = await probe(deps, `${OLLAMA_URL}/api/tags`);
    up = res.ok;
    if (res.ok) {
      const body = (await res.json()) as { models?: { name?: string }[] };
      hasModel = (body.models ?? []).some((m) => (m.name ?? "").startsWith(model));
    }
  } catch {
    up = false;
  }
  if (!up) {
    deps.stdout(`✖ Ollama not reachable at ${OLLAMA_URL} — start it (\`ollama serve\`) or`);
    deps.stdout("  install from https://ollama.com, then re-run `tachi-agent setup`.");
    return;
  }
  deps.stdout(`✓ Ollama running at ${OLLAMA_URL}`);
  if (hasModel) {
    deps.stdout(`✓ model "${model}" present`);
    return;
  }
  if (await yesNo(deps, `Model "${model}" not pulled yet — pull now (~GBs)?`, true)) {
    const code = await deps.runCommand("ollama", ["pull", model]);
    deps.stdout(code === 0 ? `✓ pulled ${model}` : `✖ ollama pull exited ${code} — pull manually later.`);
  } else {
    deps.stdout(`– skipped; run \`ollama pull ${model}\` before first chat.`);
  }
}

async function setupOpenRouter(deps: SetupDeps, file: Record<string, string>): Promise<void> {
  file.TACHI_DRIVER = "openrouter";
  const existing = file.OPENROUTER_API_KEY || deps.env.OPENROUTER_API_KEY || "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const key = await ask(
      deps,
      "OpenRouter API key (sk-or-…)",
      existing ? mask(existing) : "",
    );
    const candidate = key === mask(existing) ? existing : key;
    if (!candidate) {
      deps.stdout("– no key given; switching driver back to ollama.");
      file.TACHI_DRIVER = "ollama";
      return;
    }
    try {
      const res = await probe(deps, OPENROUTER_MODELS_URL, {
        Authorization: `Bearer ${candidate}`,
      });
      if (res.ok) {
        deps.stdout("✓ key valid — agent brain AND tachibot council will use OpenRouter");
        file.OPENROUTER_API_KEY = candidate;
        file.USE_OPENROUTER_GATEWAY = "true";
        return;
      }
      deps.stdout(`✖ OpenRouter rejected the key (HTTP ${res.status}).`);
    } catch {
      deps.stdout("✖ could not reach openrouter.ai to validate.");
    }
    if (await yesNo(deps, "Save it anyway?")) {
      file.OPENROUTER_API_KEY = candidate;
      file.USE_OPENROUTER_GATEWAY = "true";
      return;
    }
  }
  deps.stdout("– giving up on OpenRouter; driver stays ollama.");
  file.TACHI_DRIVER = "ollama";
}

async function collectExtraKeys(deps: SetupDeps, file: Record<string, string>): Promise<void> {
  if (!(await yesNo(deps, "Add more provider keys for the tachibot council (OpenAI/Gemini/Grok/…)?"))) {
    return;
  }
  for (const name of EXTRA_KEYS) {
    const existing = file[name] || deps.env[name] || "";
    const v = await ask(deps, `${name} (Enter to skip)`, existing ? mask(existing) : "");
    // Enter = skip: keep the file as-is. In particular, do NOT silently copy a
    // shell-env secret into the file just because it exists in the environment.
    if (!v || v === mask(existing)) continue;
    file[name] = v;
  }
}

async function offerFrontends(deps: SetupDeps, file: Record<string, string>): Promise<void> {
  if (await yesNo(deps, "Configure Telegram bot?")) {
    const tok = await ask(deps, "TELEGRAM_BOT_TOKEN", file.TELEGRAM_BOT_TOKEN || "");
    if (tok) {
      file.TELEGRAM_BOT_TOKEN = tok;
      const ids = await ask(deps, "TELEGRAM_ALLOWED_USER_IDS (comma-separated)", file.TELEGRAM_ALLOWED_USER_IDS || "");
      if (ids) file.TELEGRAM_ALLOWED_USER_IDS = ids;
    }
  }
  if (await yesNo(deps, "Configure Slack bot?")) {
    const bot = await ask(deps, "SLACK_BOT_TOKEN", file.SLACK_BOT_TOKEN || "");
    const app = await ask(deps, "SLACK_APP_TOKEN", file.SLACK_APP_TOKEN || "");
    if (bot) file.SLACK_BOT_TOKEN = bot;
    if (app) file.SLACK_APP_TOKEN = app;
  }
}

function printClaudeSnippets(deps: SetupDeps): void {
  deps.stdout("");
  deps.stdout("To use the stack from Claude Code:");
  deps.stdout("  claude mcp add dokoro -- dokoro");
  deps.stdout("  claude mcp add tachibot -- tachibot");
  deps.stdout("  claude mcp add tachi-agent -- tachi-agent-mcp");
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

/** Run the wizard. Returns the env-file path it wrote. */
export async function runSetup(deps: SetupDeps): Promise<string> {
  const dir = `${deps.home}/.tachi`;
  const envPath = deps.env.TACHI_ENV_FILE?.trim() || `${dir}/.env`;

  deps.stdout("tachi-agent setup — full-stack wizard (Ctrl-C anytime; re-run safe)");
  const file = parseEnvFile(await deps.readFile(envPath).catch(() => ""));
  if (Object.keys(file).length > 0) {
    deps.stdout(`✓ found existing ${envPath} — values below are your saved defaults`);
  }

  await pickBrain(deps, file);
  await collectExtraKeys(deps, file);

  // Auto-wire the stack: MCP server commands + daemon auth token.
  file.TACHIBOT_CMD = file.TACHIBOT_CMD || "tachibot";
  file.DOKORO_CMD = file.DOKORO_CMD || "dokoro";
  file.GATEWAY_TOKEN = file.GATEWAY_TOKEN || deps.env.GATEWAY_TOKEN || deps.randomToken();

  await offerFrontends(deps, file);

  await deps.mkdir(dir);
  await deps.writeFile(envPath, serializeEnvFile(file), 0o600);
  deps.stdout("");
  deps.stdout(`✓ wrote ${envPath} (chmod 600)`);

  if (await yesNo(deps, "Install the background daemon as a service (launchd, macOS)?")) {
    await deps.installService(envPath).catch((err) => {
      deps.stdout(`✖ service install failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
  if (await yesNo(deps, "Show Claude Code wiring snippets?", true)) {
    printClaudeSnippets(deps);
  }

  // Make the new values visible to the doctor run in this same process.
  // Keys that loadUserEnv() seeded from the OLD file are refreshed (the file
  // is their source of truth); anything else set in env is a real shell var
  // and still wins.
  const fromFile = new Set(deps.envFileKeys ?? []);
  for (const [k, v] of Object.entries(file)) {
    if (deps.env[k] === undefined || fromFile.has(k)) deps.env[k] = v;
  }
  deps.stdout("");
  deps.stdout("Running doctor…");
  await deps.doctor().catch(() => {});
  deps.stdout("");
  deps.stdout("Done. Try:  tachi-agent chat");
  return envPath;
}
