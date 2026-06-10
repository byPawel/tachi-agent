/**
 * macOS launchd integration — `tachi-agent service install|uninstall|status`.
 *
 * Installs the daemon (dist/daemon/index.js) as a user LaunchAgent that starts
 * at login and restarts on crash (RunAtLoad + KeepAlive). Pure generation
 * (servicePaths / parseEnvFile / generatePlist / resolveDaemonPath) is exported
 * and unit-tested; the impure shell (install/uninstall/status) is a thin layer
 * over injected deps ({ platform, home, env, uid, execFile, ... }) so tests run
 * against a temp home with a recorded fake launchctl.
 *
 * Security (council finding): the plist embeds GATEWAY_TOKEN, so it is written
 * with mode 0600 and chmod'd 0600 even when overwriting; a group/world-readable
 * --env-file triggers a `chmod 600` warning. macOS-only by design — Linux gets
 * an actionable error pointing at the README systemd guidance ("Run the daemon
 * under a supervisor").
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Pure: paths
// ---------------------------------------------------------------------------

export interface ServicePathSet {
  /** launchd label. */
  label: string;
  /** Absolute plist path under ~/Library/LaunchAgents. */
  plist: string;
  /** Log directory (StandardOutPath/StandardErrorPath live here). */
  logDir: string;
  /** Default daemon working directory (holds .tachi/ state). */
  defaultCwd: string;
}

export const SERVICE_LABEL = "com.tachi-agent.daemon";

export function servicePaths(home: string): ServicePathSet {
  return {
    label: SERVICE_LABEL,
    plist: join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`),
    logDir: join(home, "Library", "Logs", "tachi-agent"),
    defaultCwd: join(home, ".tachi-agent"),
  };
}

// ---------------------------------------------------------------------------
// Pure: env-file parsing
// ---------------------------------------------------------------------------

/**
 * Parse a dotenv-style file: KEY=VALUE per line; `export ` prefixes, comments
 * and blank lines ignored; single/double surrounding quotes stripped; values
 * may contain `=`. No interpolation — literal values only.
 */
export function parseEnvFile(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const body = trimmed.startsWith("export ") ? trimmed.slice("export ".length) : trimmed;
    const eq = body.indexOf("=");
    if (eq === -1) continue;
    const key = body.slice(0, eq).trim();
    if (!key) continue;
    let value = body.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pure: plist generation
// ---------------------------------------------------------------------------

export interface PlistOptions {
  /** Absolute node binary (process.execPath — survives nvm/volta switches). */
  nodePath: string;
  /** Absolute path to the built daemon entry (dist/daemon/index.js). */
  daemonPath: string;
  /** Daemon working directory. */
  cwd: string;
  /** Directory for daemon.log (stdout+stderr). */
  logDir: string;
  /** Environment embedded into the plist (XML-escaped). */
  env: Record<string, string>;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Hand-rolled launchd plist — every interpolated value is XML-escaped. */
export function generatePlist(opts: PlistOptions): string {
  const envEntries = Object.entries(opts.env)
    .map(([k, v]) => `      <key>${xmlEscape(k)}</key>\n      <string>${xmlEscape(v)}</string>`)
    .join("\n");
  const logFile = join(opts.logDir, "daemon.log");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xmlEscape(SERVICE_LABEL)}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${xmlEscape(opts.nodePath)}</string>
      <string>${xmlEscape(opts.daemonPath)}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${xmlEscape(opts.cwd)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${envEntries}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${xmlEscape(logFile)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(logFile)}</string>
  </dict>
</plist>
`;
}

// ---------------------------------------------------------------------------
// Pure: daemon-path resolver (built layout: dist/service.js → dist/daemon/index.js)
// ---------------------------------------------------------------------------

/**
 * Resolve the built daemon entry RELATIVE TO THIS MODULE: from dist/service.js,
 * ./daemon/index.js lands on dist/daemon/index.js. `base` is injectable for tests.
 */
export function resolveDaemonPath(base: string = import.meta.url): string {
  return fileURLToPath(new URL("./daemon/index.js", base));
}

// ---------------------------------------------------------------------------
// Impure shell — injected deps
// ---------------------------------------------------------------------------

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ServiceDeps {
  /** process.platform — refuse anything but "darwin". */
  platform: string;
  /** os.homedir(). */
  home: string;
  /** process.env (GATEWAY_TOKEN / TACHI_* picked up as plist env defaults). */
  env: Record<string, string | undefined>;
  /** process.getuid() — launchctl gui domain target. */
  uid: number;
  /** process.execPath — absolute node binary. */
  execPath: string;
  /** Never-throwing exec: resolves { code, stdout, stderr }. */
  execFile: (cmd: string, args: string[]) => Promise<ExecResult>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  /** Override for tests; default resolveDaemonPath() against the built module. */
  daemonPath?: string;
}

const NOT_DARWIN =
  "the service subcommand is macOS-only (launchd). On Linux, run the daemon under " +
  'systemd (Restart=always) — see the README section "Run the daemon under a supervisor" ' +
  "for the systemd template.";

function requireDarwin(deps: ServiceDeps): void {
  if (deps.platform !== "darwin") throw new Error(NOT_DARWIN);
}

/** Group/world-readable check: any of mode bits 0o077 set. */
function isWorldOrGroupReadable(mode: number): boolean {
  return (mode & 0o077) !== 0;
}

// ---------------------------------------------------------------------------
// serviceInstall
// ---------------------------------------------------------------------------

export async function serviceInstall(
  deps: ServiceDeps,
  opts: { envFile?: string; cwd?: string },
): Promise<void> {
  requireDarwin(deps);

  const paths = servicePaths(deps.home);
  const cwd = opts.cwd ?? paths.defaultCwd;

  // Plist env: GATEWAY_TOKEN + TACHI_* from the current env as a base, then
  // --env-file values override. GATEWAY_TOKEN is mandatory — the daemon
  // refuses to start without auth, so fail here instead of at first launch.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(deps.env)) {
    if (v !== undefined && (k === "GATEWAY_TOKEN" || k.startsWith("TACHI_"))) env[k] = v;
  }
  if (opts.envFile) {
    const raw = await readFile(opts.envFile, "utf8").catch(() => {
      throw new Error(`cannot read --env-file ${opts.envFile}`);
    });
    Object.assign(env, parseEnvFile(raw));
    // The env-file holds secrets; nudge toward 0600 if it is readable by others.
    try {
      const st = await stat(opts.envFile);
      if (isWorldOrGroupReadable(st.mode)) {
        deps.stderr(
          `warning: ${opts.envFile} is group/world-readable — it holds secrets; run: chmod 600 ${opts.envFile}`,
        );
      }
    } catch {
      /* stat failure is non-fatal — the read above already succeeded */
    }
  }
  if (!env.GATEWAY_TOKEN) {
    throw new Error(
      "GATEWAY_TOKEN is required — the daemon refuses to start without auth. " +
        "Export it or pass --env-file <file> containing GATEWAY_TOKEN=…",
    );
  }

  // Directories the daemon needs before first launch.
  await mkdir(cwd, { recursive: true });
  await mkdir(paths.logDir, { recursive: true });
  await mkdir(dirname(paths.plist), { recursive: true });

  const plistContent = generatePlist({
    nodePath: deps.execPath,
    daemonPath: deps.daemonPath ?? resolveDaemonPath(),
    cwd,
    logDir: paths.logDir,
    env,
  });
  // 0600 both at create time and via chmod: the mode option is ignored when the
  // file already exists, and the plist embeds GATEWAY_TOKEN (council finding).
  await writeFile(paths.plist, plistContent, { mode: 0o600 });
  await chmod(paths.plist, 0o600);

  // Re-installs: bootout first (ignore failure — usually "not loaded").
  await deps.execFile("launchctl", ["bootout", `gui/${deps.uid}/${paths.label}`]);
  const boot = await deps.execFile("launchctl", ["bootstrap", `gui/${deps.uid}`, paths.plist]);
  if (boot.code !== 0) {
    throw new Error(
      `launchctl bootstrap failed (exit ${boot.code}): ${boot.stderr.trim() || boot.stdout.trim() || "(no output)"}`,
    );
  }

  deps.stdout(`installed ${paths.label} (runs at login, restarts on crash)`);
  deps.stdout(`logs: ${join(paths.logDir, "daemon.log")}`);
  deps.stdout("check: tachi-agent service status");
}

// ---------------------------------------------------------------------------
// serviceUninstall
// ---------------------------------------------------------------------------

export async function serviceUninstall(deps: ServiceDeps): Promise<void> {
  requireDarwin(deps);
  const paths = servicePaths(deps.home);

  const out = await deps.execFile("launchctl", ["bootout", `gui/${deps.uid}/${paths.label}`]);
  if (out.code !== 0) {
    deps.stdout(`${paths.label}: not loaded (launchctl bootout skipped)`);
  } else {
    deps.stdout(`${paths.label}: stopped`);
  }

  try {
    await rm(paths.plist);
    deps.stdout(`removed ${paths.plist}`);
  } catch {
    deps.stdout(`plist not found — nothing to remove (${paths.plist})`);
  }
}

// ---------------------------------------------------------------------------
// serviceStatus
// ---------------------------------------------------------------------------

export async function serviceStatus(deps: ServiceDeps): Promise<void> {
  requireDarwin(deps);
  const paths = servicePaths(deps.home);

  const res = await deps.execFile("launchctl", ["print", `gui/${deps.uid}/${paths.label}`]);
  if (res.code !== 0) {
    deps.stdout(
      `${paths.label}: not loaded — install with: tachi-agent service install --env-file <file-with-GATEWAY_TOKEN>`,
    );
    return;
  }
  const state = /state\s*=\s*(\S+)/.exec(res.stdout)?.[1] ?? "loaded";
  const pid = /pid\s*=\s*(\d+)/.exec(res.stdout)?.[1];
  deps.stdout(`${paths.label}: ${state}${pid ? ` (pid ${pid})` : ""}`);
  deps.stdout(`logs: ${join(paths.logDir, "daemon.log")}`);
}
