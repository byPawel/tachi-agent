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
 *   Herdr app → `herdr-app ls` finds Claude's pane, `herdr-app do pane.split` opens the
 *             watcher beside it; messages via `hc send <terminal>` (paste + Enter;
 *             refused while Claude sits at a dialog)
 *   zellij  → `zellij run --direction right …`
 *   WezTerm → `wezterm cli split-pane --right …`
 *   kitty   → `kitty @ launch --location=vsplit …` (needs remote control on a socket)
 *   Ghostty → AppleScript `split` of the terminal on Claude's tty (macOS, Ghostty 1.3+)
 *   iTerm2  → AppleScript `split vertically` of Claude's session (macOS)
 *   other   → no split API; print the command for the user to run in a pane
 *
 * A multiplexer is detected by the env it gives its panes. A terminal app is only
 * trusted when it can be matched to Claude's own pane (tty, session id): several apps
 * embed Ghostty and report TERM_PROGRAM=ghostty without being Ghostty.
 *
 * Message targets are `herdr:<pane>` for Herdr, `hc:<terminal>` for the Herdr app, a
 * bare cmux surface otherwise. Without a target the approved text is printed for copy-paste.
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

export function shellQuote(a: string): string {
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
  if (env.HC_TERMINAL_ID && env.HC_TERMINAL_SOCKET) return `hc:${env.HC_TERMINAL_ID}`;
  return env.CMUX_SURFACE_ID || undefined;
}

/** The pane showing terminal `terminal`, from `herdr-app ls` JSON (spaces → tabs → terminals). */
export function herdrAppPane(stdout: string, terminal: string): string | undefined {
  try {
    const spaces = (JSON.parse(stdout) as { spaces?: Array<{ tabs?: Array<{ terminals?: Array<{ terminal?: unknown; pane?: unknown }> }> }> }).spaces ?? [];
    for (const sp of spaces) for (const tab of sp.tabs ?? []) for (const t of tab.terminals ?? []) {
      if (t.terminal === terminal && typeof t.pane === "string") return t.pane;
    }
  } catch {
    // not JSON: the app isn't showing a window
  }
  return undefined;
}

/** Where the launching shell runs — what a terminal app needs to find Claude's own pane. */
export interface Host {
  /** process.platform */
  platform?: string;
  /** Claude's tty device, e.g. /dev/ttys016 */
  tty?: string;
}

// AppleScript takes its values as `on run argv`, so nothing from the repo path is ever spliced into script source.
const GHOSTTY_SPLIT = [
  "on run argv",
  'if application "Ghostty" is not running then error "Ghostty is not running"',
  'tell application "Ghostty"',
  "set claude to first terminal whose tty is (item 1 of argv)",
  "set cfg to new surface configuration",
  "set command of cfg to (item 2 of argv)",
  "set initial working directory of cfg to (item 3 of argv)",
  "split claude direction right with configuration cfg",
  "focus claude",
  "end tell",
  "end run",
];
const ITERM_SPLIT = [
  "on run argv",
  'if application "iTerm2" is not running then error "iTerm2 is not running"',
  'tell application "iTerm2"',
  "repeat with w in windows",
  "repeat with t in tabs of w",
  "repeat with s in sessions of t",
  "if (id of s as text) is (item 1 of argv) then",
  "tell s to split vertically with default profile command (item 2 of argv)",
  "return",
  "end if",
  "end repeat",
  "end repeat",
  "end repeat",
  'error "no iTerm2 session " & (item 1 of argv)',
  "end tell",
  "end run",
];
const osascript = (lines: string[], args: string[]): Command => ({ cmd: "osascript", args: [...lines.flatMap((l) => ["-e", l]), "--", ...args] });

/** Pane id from `herdr pane split` JSON (`.result.pane.pane_id`). */
export function herdrPaneId(stdout: string): string | undefined {
  try {
    const id = (JSON.parse(stdout) as { result?: { pane?: { pane_id?: unknown } } }).result?.pane?.pane_id;
    return typeof id === "string" || typeof id === "number" ? String(id) : undefined;
  } catch {
    return undefined;
  }
}

export type OpenPlan =
  | { kind: "cmux" | "tmux" | "zellij" | "wezterm" | "kitty" | "ghostty" | "iterm"; command: Command }
  | { kind: "herdr"; split: Command; run: (pane: string) => Command }
  | { kind: "herdr-app"; list: Command; terminal: string; split: (pane: string) => Command }
  | { kind: "manual"; shell: string; hint?: string };

export function buildOpenCommand(argv: string[], env: Env, host: Host = {}): OpenPlan {
  const shell = argv.map(shellQuote).join(" ");
  const cwdOf = () => argv[argv.indexOf("--cwd") + 1] ?? ".";
  if (env.HERDR_ENV === "1" && env.HERDR_PANE_ID) {
    return {
      kind: "herdr",
      split: { cmd: "herdr", args: ["pane", "split", "--current", "--direction", "right", "--cwd", cwdOf(), "--no-focus"] },
      run: (pane) => ({ cmd: "herdr", args: ["pane", "run", pane, `exec ${shell}`] }),
    };
  }
  if (env.HC_TERMINAL_ID && env.HC_TERMINAL_SOCKET) {
    return {
      kind: "herdr-app",
      list: { cmd: "herdr-app", args: ["ls"] },
      terminal: env.HC_TERMINAL_ID,
      split: (pane) => ({ cmd: "herdr-app", args: ["do", "pane.split", JSON.stringify({ direction: "right", pane, argv })] }),
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
  if (env.ZELLIJ !== undefined) {
    return { kind: "zellij", command: { cmd: "zellij", args: ["run", "--direction", "right", "--close-on-exit", "--name", "tachi-watch", "--cwd", cwdOf(), "--", ...argv] } };
  }
  if (env.WEZTERM_PANE) {
    return { kind: "wezterm", command: { cmd: "wezterm", args: ["cli", "split-pane", "--right", "--percent", "40", "--pane-id", env.WEZTERM_PANE, "--", ...argv] } };
  }
  if (env.KITTY_WINDOW_ID) {
    // remote control over the tty needs a tty, and Claude's `!` shell has none: only a socket works
    if (!env.KITTY_LISTEN_ON) {
      return { kind: "manual", shell, hint: "kitty can open the split itself once remote control listens on a socket — in kitty.conf: `allow_remote_control yes` and `listen_on unix:/tmp/kitty`" };
    }
    return {
      kind: "kitty",
      command: {
        cmd: env.KITTY_BIN || "kitty",
        args: ["@", "--to", env.KITTY_LISTEN_ON, "launch", "--type=window", "--location=vsplit", "--next-to", `id:${env.KITTY_WINDOW_ID}`, "--keep-focus", "--cwd", cwdOf(), "--title", "tachi-watch", "--", ...argv],
      },
    };
  }
  if (host.platform === "darwin" && env.TERM_PROGRAM === "ghostty" && host.tty) {
    return { kind: "ghostty", command: osascript(GHOSTTY_SPLIT, [host.tty, shell, cwdOf()]) };
  }
  // ITERM_SESSION_ID is "w0t0p0:<session id>"
  const iterm = /:([0-9A-Fa-f-]{8,})$/.exec(env.ITERM_SESSION_ID ?? "")?.[1];
  if (host.platform === "darwin" && iterm) return { kind: "iterm", command: osascript(ITERM_SPLIT, [iterm, shell]) };
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
  // no --force: hc refuses while Claude is blocked on a dialog, so the Enter can never answer one
  if (target.startsWith("hc:")) return { cmd: "hc", args: ["send", target.slice(3), `[tachi-watch] ${text}`] };
  const cmux = env.CMUX_BUNDLED_CLI_PATH || "cmux";
  return { cmd: cmux, args: ["agent", "message", target, "--from", "tachi-watch", "--json", "--", text] };
}

/** cmux: the target pane's inbox — where a sent message turns from queued into delivered/read. */
export function buildInboxCommand(target: string | undefined, env: Env): Command | undefined {
  if (!target || /^(herdr|hc):/.test(target)) return undefined;
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

/** Does this terminal draw 24-bit colour? Decided from its env; unknown terminals get the 256-colour palette. */
export function supportsTruecolor(env: Env): boolean {
  if (/^(truecolor|24bit)$/i.test(env.COLORTERM ?? "")) return true;
  if (/^(iTerm\.app|ghostty|WezTerm|vscode|Hyper|rio|WarpTerminal)$/.test(env.TERM_PROGRAM ?? "")) return true;
  return /(-direct|kitty|ghostty|wezterm|alacritty|foot|contour)/.test(env.TERM ?? "");
}

/** Nearest xterm-256 palette index: the grey ramp for greys, the 6×6×6 cube otherwise. */
function ansi256(r: number, g: number, b: number): number {
  if (Math.max(r, g, b) - Math.min(r, g, b) < 12) {
    const v = (r + g + b) / 3;
    return v < 5 ? 16 : v > 243 ? 231 : 232 + Math.min(23, Math.round((v - 8) / 10));
  }
  const q = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.round((v - 35) / 40)));
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

/**
 * Rewrite 24-bit colour (`38;2;r;g;b` / `48;2;r;g;b`) as 256-colour. A terminal without
 * truecolor reads those five numbers as five separate styles — blink, faint, stray colours.
 */
export function to256(s: string): string {
  if (!s.includes(";2;")) return s;
  return s.replace(/\x1b\[([0-9;]*)m/g, (whole, params: string) => {
    if (!params.includes(";2;")) return whole;
    const p = params.split(";");
    const out: string[] = [];
    for (let i = 0; i < p.length; i++) {
      if ((p[i] === "38" || p[i] === "48") && p[i + 1] === "2" && i + 4 < p.length) {
        out.push(p[i], "5", String(ansi256(Number(p[i + 2]), Number(p[i + 3]), Number(p[i + 4]))));
        i += 4;
      } else out.push(p[i]);
    }
    return `\x1b[${out.join(";")}m`;
  });
}
