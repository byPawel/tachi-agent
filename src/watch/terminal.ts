/**
 * tachi-watch — terminal plumbing, pure: the command that opens the watcher in
 * a split next to Claude, and the command that delivers an approved message
 * back to Claude.
 *
 *   cmux    → `cmux new-split right --command …`; messages via `cmux agent message`
 *             (delivered through Claude's hooks — never typed into its prompt)
 *   tmux    → `tmux split-window -h -d …`
 *   Herdr   → `herdr pane split --current …` then `herdr pane run <pane> …`;
 *             messages via `herdr agent prompt <claude pane>` (bracketed paste +
 *             Enter; refused while Claude sits at an approval dialog)
 *   WezTerm → `wezterm cli split-pane --right …`
 *   other   → no split API; print the command for the user to run in a pane
 *
 * Message targets are `herdr:<pane>` for Herdr, a bare cmux surface otherwise.
 * Without a target the approved text is printed for copy-paste.
 */

type Env = Record<string, string | undefined>;

export interface WatchLaunch {
  /** Claude Code session to follow (CLAUDE_CODE_SESSION_ID of the launching shell). */
  session: string;
  /** Project dir Claude runs in (selects the transcript folder). */
  cwd: string;
  /** Claude pane — where approved messages go: a cmux surface or `herdr:<pane>`. */
  target?: string;
  /** Claude Code's pid — picks the tachibot it spawned when several run in one project. */
  claudePid?: number;
}

export interface Command {
  cmd: string;
  args: string[];
}

function shellQuote(a: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
}

/** argv for the watcher process itself. */
export function watchArgv(nodePath: string, cliPath: string, l: WatchLaunch): string[] {
  const argv = [nodePath, cliPath, "watch", "--session", l.session, "--cwd", l.cwd];
  if (l.target) argv.push("--target", l.target);
  if (l.claudePid) argv.push("--claude-pid", String(l.claudePid));
  return argv;
}

/** The calling pane as a message target, from the terminal's env. */
export function defaultTarget(env: Env): string | undefined {
  if (env.HERDR_ENV === "1" && env.HERDR_PANE_ID) return `herdr:${env.HERDR_PANE_ID}`;
  return env.CMUX_SURFACE_ID || undefined;
}

/** Pane id from `herdr pane split` JSON (`.result.pane.pane_id`). */
export function herdrPaneId(stdout: string): string | undefined {
  try {
    const id = (JSON.parse(stdout) as { result?: { pane?: { pane_id?: unknown } } }).result?.pane?.pane_id;
    return typeof id === "string" || typeof id === "number" ? String(id) : undefined;
  } catch {
    return undefined;
  }
}

export function buildOpenCommand(
  argv: string[],
  env: Env,
):
  | { kind: "cmux" | "tmux" | "wezterm"; command: Command }
  | { kind: "herdr"; split: Command; run: (pane: string) => Command }
  | { kind: "manual"; shell: string } {
  const shell = argv.map(shellQuote).join(" ");
  if (env.HERDR_ENV === "1" && env.HERDR_PANE_ID) {
    const cwd = argv[argv.indexOf("--cwd") + 1] ?? ".";
    return {
      kind: "herdr",
      split: { cmd: "herdr", args: ["pane", "split", "--current", "--direction", "right", "--cwd", cwd, "--no-focus"] },
      run: (pane) => ({ cmd: "herdr", args: ["pane", "run", pane, `exec ${shell}`] }),
    };
  }
  if (env.CMUX_SURFACE_ID) {
    const cmux = env.CMUX_BUNDLED_CLI_PATH || "cmux";
    return {
      kind: "cmux",
      // exec: the pane closes with the watcher, so a relaunch never leaves an idle shell
      // behind that squeezes the next split narrower
      command: { cmd: cmux, args: ["new-split", "right", "--surface", env.CMUX_SURFACE_ID, "--command", `exec ${shell}`, "--focus", "false"] },
    };
  }
  if (env.TMUX) return { kind: "tmux", command: { cmd: "tmux", args: ["split-window", "-h", "-d", "-l", "40%", shell] } };
  if (env.WEZTERM_PANE) {
    return { kind: "wezterm", command: { cmd: "wezterm", args: ["cli", "split-pane", "--right", "--percent", "40", "--pane-id", env.WEZTERM_PANE, "--", ...argv] } };
  }
  return { kind: "manual", shell };
}

/** Command that delivers an approved message to Claude, or undefined when there's no channel. */
/**
 * Text as cmux/herdr accept it: pasted terminal text carries \r line ends and
 * stray control/escape bytes, which cmux rejects ("Only text, newlines and tabs
 * are allowed") and which garble the pane (\r returns the cursor and overprints).
 */
export function cleanText(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .trim();
}

export function buildSendCommand(target: string | undefined, text: string, env: Env): Command | undefined {
  if (!target) return undefined;
  text = cleanText(text);
  if (target.startsWith("herdr:")) return { cmd: "herdr", args: ["agent", "prompt", target.slice(6), `[tachi-watch] ${text}`] };
  const cmux = env.CMUX_BUNDLED_CLI_PATH || "cmux";
  return { cmd: cmux, args: ["agent", "message", target, "--from", "tachi-watch", "--json", "--", text] };
}

/** cmux: the target pane's inbox — where a sent message turns from queued into delivered/read. */
export function buildInboxCommand(target: string | undefined, env: Env): Command | undefined {
  if (!target || target.startsWith("herdr:")) return undefined;
  return { cmd: env.CMUX_BUNDLED_CLI_PATH || "cmux", args: ["agent", "inbox", "--surface", target, "--json"] };
}

export interface Receipt {
  state: string;
  via?: string;
}

/** Find one message in `cmux agent inbox --json` output. */
export function parseInbox(json: string, id: string): Receipt | undefined {
  try {
    const raw = JSON.parse(json) as unknown;
    const list = Array.isArray(raw) ? raw : (raw as { messages?: unknown[] })?.messages ?? [];
    const m = (list as Array<Record<string, unknown>>).find((x) => x?.id === id);
    if (!m) return undefined;
    return { state: String(m.state ?? (m.read_at ? "read" : m.delivered_at ? "delivered" : "queued")), via: m.delivered_via ? String(m.delivered_via) : undefined };
  } catch {
    return undefined;
  }
}
