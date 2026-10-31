/**
 * tachi-watch — event model + pure parsers for the two live sources:
 *   1. the Claude Code session transcript (~/.claude/projects/<dir>/<session>.jsonl)
 *   2. the tachibot trace stream (SSE from a tachibot running with TACHIBOT_TRACE_UI=1)
 *
 * Events carry an `id` so a result can be folded into the card of the call that
 * produced it (Claude tool_use ↔ tool_result, tachibot span.start ↔ span.end).
 *
 * No I/O here — sources.ts does the tailing/streaming, the store builds cards.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export type WatchKind =
  | "prompt"      // user typed to Claude
  | "text"        // Claude said something
  | "tool"        // Claude called a tool
  | "tool-ok"     // a Claude tool call returned
  | "tool-bg"     // a slow call was moved to the background; its result comes later by task id
  | "tool-error"  // a Claude tool call failed
  | "span"        // tachibot tool/model call started
  | "model"       // tachibot call finished
  | "model-error" // tachibot call failed
  | "fallback"    // tachibot answered with a different model than requested
  | "thought"     // tachibot nextThought step
  | "usage";      // tokens a tachibot model call spent

export interface WatchEvent {
  source: "claude" | "tachibot";
  kind: WatchKind;
  /** One-line summary — what the reviewer reads and repeat detection keys on. */
  text: string;
  ts: number;
  /** Call id: tool_use id / tachibot span id. Results share their call's id. */
  id?: string;
  /** tachibot: the enclosing span (model calls nest under their tool). */
  parentId?: string;
  input?: string;
  output?: string;
  /** Multi-line output (ANSI stripped, capped) for expanded cards. */
  outputFull?: string;
  /** Every argument of a tool call, one `key: value` per line. */
  inputFull?: string;
  /** The output with tachibot's own terminal styling kept (colors, banners, tables). */
  outputAnsi?: string;
  ms?: number;
  /** Claude called a tachibot tool (mcp__tachibot-mcp__*). */
  via?: "tachibot";
  /** Bare tool name: Claude's `jury` for mcp__tachibot-mcp__jury, tachibot span name for spans. */
  tool?: string;
  /** tachibot span kind. */
  spanKind?: "tool" | "model";
  /** Background task id linking a tool-bg call to its later result. */
  taskId?: string;
  /** usage: tokens the model call spent */
  tokensIn?: number;
  tokensOut?: number;
  tokensReasoning?: number;
}

const PREVIEW = 300;

/** Remove terminal escape sequences (tachibot output is ANSI-rendered). */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "").replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/\x1b/g, "");
}

/** Keep terminal styling but drop anything that could move the cursor or retitle the pane. */
export function safeAnsi(s: string, max = 30_000): string {
  const t = s
    .replace(/\x1b(\d{1,3}(?:;\d{1,3})*m)/g, "\x1b[$1") // "ESC 1m" with the "[" lost upstream → a real SGR
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "") // OSC (titles, hyperlinks)
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-ln-~]/g, "")        // every CSI except SGR (…m)
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    // allowlist: an ESC that does not start a well-formed SGR, and every C1/other control byte, is dropped
    .replace(/\x1b(?!\[[0-9;]*m)/g, "")
    .replace(/[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f\x80-\x9f]/g, "")
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…\x1b[0m` : t;
}

/** Multi-line preview: ANSI stripped, blank runs collapsed, capped. */
export function fullText(s: string, max = 4000): string {
  const t = stripAnsi(s).replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function clip(s: string, max = PREVIEW): string {
  const one = stripAnsi(s).replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

// ---------------------------------------------------------------------------
// Claude Code transcript
// ---------------------------------------------------------------------------

/** Claude Code's per-project dir name: every non-alphanumeric char becomes `-`. */
export function claudeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

export function claudeTranscriptPath(cwd: string, sessionId: string, home: string = homedir()): string {
  return join(home, ".claude", "projects", claudeProjectDir(cwd), `${sessionId}.jsonl`);
}

/** All arguments of a tool call as readable `key: value` lines (long values capped). */
export function formatArgs(input: unknown, cap = 6000): string {
  if (!input || typeof input !== "object") return input === undefined ? "" : String(input);
  return Object.entries(input as Record<string, unknown>)
    .map(([k, v]) => {
      const val = typeof v === "string" ? v : JSON.stringify(v);
      return `${k}: ${val.length > cap ? `${val.slice(0, cap - 1)}…` : val}`;
    })
    .join("\n");
}

/** The bit of a tool's input worth showing: the command, the file, or the query. */
export function summarizeToolInput(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const pick = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.query ?? i.url ?? i.question ?? i.prompt ?? i.problem ?? i.thought ?? i.description;
  if (typeof pick === "string") return clip(pick, 160);
  try {
    return clip(JSON.stringify(i), 160);
  } catch {
    return name;
  }
}

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : "")).join(" ");
  return "";
}

/** Harness-injected user turns (reminders, command echoes, hook output) — not the human. */
function isInjected(text: string): boolean {
  return /^\s*<(system-reminder|command-name|command-message|local-command|task-notification|bash-|user-prompt-submit-hook)/.test(text);
}

/** `<task-notification><task-id>…</task-id><status>…</status>…<result>…</result>` → parts. */
export function parseTaskNotification(s: string): { taskId: string; ok: boolean; result: string } | undefined {
  if (!s.includes("<task-notification>")) return undefined;
  const id = /<task-id>([^<]+)<\/task-id>/.exec(s)?.[1]?.trim();
  if (!id) return undefined;
  const status = /<status>([^<]+)<\/status>/.exec(s)?.[1]?.trim() ?? "completed";
  const result = /<result>\n?([\s\S]*?)\n?<\/result>/.exec(s)?.[1] ?? /<summary>([^<]*)<\/summary>/.exec(s)?.[1] ?? "";
  return { taskId: id, ok: status === "completed", result };
}

/** MCP tools arrive as `mcp__server__tool`; show `server · tool`. */
export function toolLabel(name: string): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? `${m[1]} · ${m[2]}` : name;
}

/** One transcript JSONL entry → zero or more watch events. Unknown shapes → []. */
export function parseClaudeEntry(entry: unknown, now: number = Date.now()): WatchEvent[] {
  if (!entry || typeof entry !== "object") return [];
  const e = entry as { type?: string; operation?: string; content?: unknown; timestamp?: string; message?: { content?: unknown } };
  const ts = e.timestamp ? Date.parse(e.timestamp) || now : now;
  const content = e.message?.content;
  const out: WatchEvent[] = [];

  // A backgrounded tool call's result arrives later as a queued <task-notification>.
  if (e.type === "queue-operation" && e.operation === "enqueue" && typeof e.content === "string") {
    const n = parseTaskNotification(e.content);
    if (n) {
      const output = clip(n.result);
      out.push({
        source: "claude", kind: n.ok ? "tool-ok" : "tool-error", text: output, ts, taskId: n.taskId, output,
        outputFull: fullText(n.result, 20_000), outputAnsi: n.result.includes("\x1b[") ? safeAnsi(n.result) : undefined,
      });
    }
    return out;
  }

  if (e.type === "user") {
    if (typeof content === "string") {
      if (!isInjected(content) && content.trim()) out.push({ source: "claude", kind: "prompt", text: clip(content), ts });
      return out;
    }
    if (!Array.isArray(content)) return out;
    for (const b of content as Array<Record<string, unknown>>) {
      if (b?.type === "text" && typeof b.text === "string" && !isInjected(b.text) && b.text.trim()) {
        out.push({ source: "claude", kind: "prompt", text: clip(b.text), ts });
      } else if (b?.type === "tool_result") {
        const raw = blockText(b.content);
        const bg = /moved to the background as task (\w+)/.exec(raw);
        if (bg && typeof b.tool_use_id === "string") {
          out.push({ source: "claude", kind: "tool-bg", text: `background task ${bg[1]}`, ts, id: b.tool_use_id, taskId: bg[1] });
          continue;
        }
        const output = clip(raw);
        const outputFull = fullText(raw, 20_000);
        const outputAnsi = raw.includes("\x1b[") ? safeAnsi(raw) : undefined;
        const id = typeof b.tool_use_id === "string" ? b.tool_use_id : undefined;
        out.push(b.is_error === true
          ? { source: "claude", kind: "tool-error", text: output, ts, id, output, outputFull, outputAnsi }
          : { source: "claude", kind: "tool-ok", text: output, ts, id, output, outputFull, outputAnsi });
      }
    }
    return out;
  }

  if (e.type === "assistant" && Array.isArray(content)) {
    for (const b of content as Array<Record<string, unknown>>) {
      if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
        out.push({ source: "claude", kind: "text", text: clip(b.text), ts });
      } else if (b?.type === "tool_use" && typeof b.name === "string") {
        const input = summarizeToolInput(b.name, b.input);
        const tachibot = /^mcp__tachibot[-_]mcp__(.+)$/.exec(b.name);
        out.push({
          source: "claude", kind: "tool", text: `${toolLabel(b.name)}: ${input}`, ts,
          id: typeof b.id === "string" ? b.id : undefined, input, inputFull: formatArgs(b.input),
          ...(tachibot ? { via: "tachibot" as const, tool: tachibot[1] } : { tool: b.name }),
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// tachibot trace stream
// ---------------------------------------------------------------------------

/** Shape of a tachibot trace event (mirrors tachibot-mcp src/utils/trace-bus.ts). */
export interface TachibotTraceEvent {
  type: "span.start" | "span.end" | "thought" | "usage";
  id: string;
  parentId?: string;
  kind?: "tool" | "model";
  name: string;
  ts: number;
  input?: string;
  output?: string;
  ms?: number;
  error?: string;
  degradedTo?: string;
  thoughtNumber?: number;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  tokensReasoning?: number;
}

const tb = (id: string) => `tb:${id}`;

export function parseTraceEvent(e: TachibotTraceEvent): WatchEvent | undefined {
  const base = {
    source: "tachibot" as const, ts: e.ts, id: tb(e.id), parentId: e.parentId ? tb(e.parentId) : undefined,
    tool: e.name, spanKind: e.kind,
  };
  if (e.type === "usage") {
    // the tokens belong to the model span that was running (its parent)
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
    if (!e.parentId) return undefined;
    return { ...base, id: tb(e.parentId), kind: "usage", text: "usage", tokensIn: n(e.tokensIn), tokensOut: n(e.tokensOut), tokensReasoning: n(e.tokensReasoning) };
  }
  if (e.type === "thought") {
    return { ...base, kind: "thought", text: `#${e.thoughtNumber}${e.model ? ` (${e.model})` : ""} ${clip(e.input ?? "", 200)}`, input: clip(e.input ?? ""), output: e.output ? clip(e.output) : undefined };
  }
  if (e.type === "span.start") {
    return { ...base, kind: "span", text: `${e.kind ?? "span"} ${e.name}`, input: e.input ? clip(e.input) : undefined };
  }
  const secs = e.ms === undefined ? "" : ` ${(e.ms / 1000).toFixed(1)}s`;
  if (e.error) {
    return { ...base, kind: "model-error", text: `${e.kind ?? "span"} ${e.name}${secs}: ${clip(e.error, 200)}`, output: clip(e.error), ms: e.ms };
  }
  if (e.degradedTo) {
    return { ...base, kind: "fallback", text: `${e.name} → answered by ${e.degradedTo}${secs}`, output: e.output ? clip(e.output) : undefined, ms: e.ms };
  }
  return {
    ...base, kind: "model", text: `${e.kind ?? "span"} ${e.name}${secs}`, ms: e.ms,
    output: e.output ? clip(e.output) : undefined, outputFull: e.output ? fullText(e.output) : undefined,
  };
}

/**
 * Where tachibot writes its trace registry (one 0600 JSON per live server).
 * Mirrors env-paths('tachibot', {suffix: ''}).data + '/trace'. Override:
 * TACHI_WATCH_TRACE_DIR.
 */
export function tachibotTraceDir(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (env.TACHI_WATCH_TRACE_DIR) return env.TACHI_WATCH_TRACE_DIR;
  if (platform === "darwin") return join(home, "Library", "Application Support", "tachibot", "trace");
  if (platform === "win32") return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "tachibot", "Data", "trace");
  return join(env.XDG_DATA_HOME || join(home, ".local", "share"), "tachibot", "trace");
}
