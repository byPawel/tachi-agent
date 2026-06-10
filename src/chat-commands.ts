/**
 * Unified chat-command layer — ONE command surface for every conversational
 * frontend (terminal REPL, Telegram). Frontends parse a line; commands either
 * return reply text (info/session commands), or rewrite into an agent task
 * (/jury, /search, /think), or fall through as a plain message. All state
 * lives in the injected Session; all IO goes through injected deps.
 *
 * Transparency note (council finding): when a command returns kind:"run",
 * frontends MUST echo the rewritten task before running it (REPL: `→ ${text}`
 * to stderr; Telegram: prepend `→ ${text}` line to the status message) so
 * command rewrites are never silent.
 */
import type { Skill } from "./skills.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ChatSession {
  driver?: string;
  skill?: Skill;
}

export interface ChatDeps {
  session: ChatSession;
  skills: Skill[];
  /** Frontend-truthful introspection (REPL local mode has real answers; daemon mode reports that). */
  listTools: () => string;
  modelName: () => string;
  mode: string; // e.g. "local" | "daemon <url>"
  /** Queue ops — bound to cli-commands.ts fns with a string-collector stdout, or null when unavailable. */
  taskAdd: ((text: string, opts: { driver?: string }) => Promise<string>) | null;
  taskList: (() => Promise<string>) | null;
  taskShow: ((id: string) => Promise<string>) | null;
  scheduleList: (() => Promise<string>) | null;
}

export type ChatAction =
  | { kind: "reply"; text: string }
  | { kind: "run"; text: string } // rewritten task — run through the agent with session driver/skill
  | { kind: "message"; text: string } // plain text — run as-is with session driver/skill
  | { kind: "exit" };

// ---------------------------------------------------------------------------
// CHAT_HELP
// ---------------------------------------------------------------------------

export const CHAT_HELP = `commands:
  /help                  show this
  /tools                 list the agent's available tools
  /model                 show the current model
  /status                show session state (driver, skill, mode)
  /driver <name>|off     set or clear the session driver
  /skill <name>|off      activate or clear a skill bundle
  /reset                 clear the full session (driver + skill)
  /jury <question>       run a cross-model jury verdict via tachibot_jury
  /search <query>        search with tachibot_grok_search or perplexity
  /think <question>      reason step by step over a question
  /task add <text>       queue a task on the daemon
  /task list             list queued tasks
  /task show <id>        show task detail
  /schedule list         list scheduled jobs
  /exit, /quit           leave (REPL: Ctrl-D also exits; Telegram: n/a)`;

// ---------------------------------------------------------------------------
// Daemon-unavailable hint (shared)
// ---------------------------------------------------------------------------

const DAEMON_HINT =
  "This command needs a running daemon — set TACHI_DAEMON_URL and GATEWAY_TOKEN.";

// ---------------------------------------------------------------------------
// resolveRunOptions — SINGLE source of driver precedence
// ---------------------------------------------------------------------------

/**
 * Session → run options. Single source of the precedence rule:
 * session.driver > skill.driver > undefined (env default applies downstream).
 */
export function resolveRunOptions(session: ChatSession): {
  driver?: string;
  systemPrompt?: string;
  allowTools?: string[];
} {
  const result: { driver?: string; systemPrompt?: string; allowTools?: string[] } = {};

  // Driver precedence: session.driver > skill.driver > undefined
  if (session.driver !== undefined) {
    result.driver = session.driver;
  } else if (session.skill?.driver !== undefined) {
    result.driver = session.skill.driver;
  }

  // Skill contributes systemPrompt and allowTools
  if (session.skill) {
    if (session.skill.prompt) {
      result.systemPrompt = session.skill.prompt;
    }
    if (session.skill.tools && session.skill.tools.length > 0) {
      result.allowTools = session.skill.tools;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// handleChatLine
// ---------------------------------------------------------------------------

/** Parse and execute one chat input line. Pure w.r.t. session state (mutations go through deps.session). */
export async function handleChatLine(
  line: string,
  deps: ChatDeps,
): Promise<ChatAction> {
  const trimmed = line.trim();

  // Empty line
  if (!trimmed) {
    return { kind: "reply", text: "" };
  }

  // Non-command: plain message
  if (!trimmed.startsWith("/")) {
    return { kind: "message", text: trimmed };
  }

  // Parse command and optional argument string
  const spaceIdx = trimmed.indexOf(" ");
  const cmd = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const argStr = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

  switch (cmd) {
    // -------------------------------------------------------------------
    case "/help":
      return { kind: "reply", text: CHAT_HELP };

    // -------------------------------------------------------------------
    case "/tools":
      return { kind: "reply", text: deps.listTools() };

    // -------------------------------------------------------------------
    case "/model":
      return { kind: "reply", text: deps.modelName() };

    // -------------------------------------------------------------------
    case "/status": {
      const driverLabel = deps.session.driver ?? "(none)";
      const skillLabel = deps.session.skill?.name ?? "(none)";
      const text = [
        `mode:   ${deps.mode}`,
        `driver: ${driverLabel}`,
        `skill:  ${skillLabel}`,
        `model:  ${deps.modelName()}`,
      ].join("\n");
      return { kind: "reply", text };
    }

    // -------------------------------------------------------------------
    case "/driver": {
      if (!argStr) {
        return { kind: "reply", text: "Usage: /driver <name>|off" };
      }
      if (argStr === "off") {
        delete deps.session.driver;
        return { kind: "reply", text: "Driver cleared." };
      }
      deps.session.driver = argStr;
      return { kind: "reply", text: `Driver set to: ${argStr}` };
    }

    // -------------------------------------------------------------------
    case "/skill": {
      if (!argStr) {
        return { kind: "reply", text: "Usage: /skill <name>|off" };
      }
      if (argStr === "off") {
        delete deps.session.skill;
        return { kind: "reply", text: "Skill cleared." };
      }
      const found = deps.skills.find((s) => s.name === argStr) ?? null;
      if (!found) {
        if (deps.skills.length === 0) {
          return { kind: "reply", text: "No skills are available in this session." };
        }
        const names = deps.skills.map((s) => `  ${s.name}`).join("\n");
        return { kind: "reply", text: `Skill not found: "${argStr}". Available skills:\n${names}` };
      }
      deps.session.skill = found;
      return { kind: "reply", text: `Skill activated: ${found.name}` };
    }

    // -------------------------------------------------------------------
    case "/reset": {
      delete deps.session.driver;
      delete deps.session.skill;
      return { kind: "reply", text: "Session reset — driver and skill cleared." };
    }

    // -------------------------------------------------------------------
    case "/jury": {
      if (!argStr) {
        return { kind: "reply", text: "Usage: /jury <question>" };
      }
      return {
        kind: "run",
        text: `Use tachibot_jury to deliver a cross-model verdict on: ${argStr}`,
      };
    }

    // -------------------------------------------------------------------
    case "/search": {
      if (!argStr) {
        return { kind: "reply", text: "Usage: /search <query>" };
      }
      return {
        kind: "run",
        text: `Use tachibot_grok_search (or perplexity) to look up: ${argStr}`,
      };
    }

    // -------------------------------------------------------------------
    case "/think": {
      if (!argStr) {
        return { kind: "reply", text: "Usage: /think <question>" };
      }
      return {
        kind: "run",
        text: `Reason carefully step by step: ${argStr}`,
      };
    }

    // -------------------------------------------------------------------
    case "/task": {
      const [sub, ...taskArgs] = argStr.split(/\s+/).filter(Boolean);
      if (!sub || (sub !== "add" && sub !== "list" && sub !== "show")) {
        return { kind: "reply", text: "Usage: /task add <text> | /task list | /task show <id>" };
      }

      if (sub === "list") {
        if (!deps.taskList) return { kind: "reply", text: DAEMON_HINT };
        const result = await deps.taskList();
        return { kind: "reply", text: result };
      }

      if (sub === "show") {
        if (!deps.taskShow) return { kind: "reply", text: DAEMON_HINT };
        const id = taskArgs[0] ?? "";
        const result = await deps.taskShow(id);
        return { kind: "reply", text: result };
      }

      // sub === "add"
      if (!deps.taskAdd) return { kind: "reply", text: DAEMON_HINT };
      const taskText = taskArgs.join(" ");
      const addOpts: { driver?: string } = {};
      if (deps.session.driver) addOpts.driver = deps.session.driver;
      const result = await deps.taskAdd(taskText, addOpts);
      return { kind: "reply", text: result };
    }

    // -------------------------------------------------------------------
    case "/schedule": {
      const sub = argStr.split(/\s+/)[0];
      if (sub === "list") {
        if (!deps.scheduleList) return { kind: "reply", text: DAEMON_HINT };
        const result = await deps.scheduleList();
        return { kind: "reply", text: result };
      }
      return { kind: "reply", text: "Usage: /schedule list" };
    }

    // -------------------------------------------------------------------
    case "/exit":
    case "/quit":
      return { kind: "exit" };

    // -------------------------------------------------------------------
    default:
      return {
        kind: "reply",
        text: `Unknown command: ${cmd}. Try /help for the list of commands.`,
      };
  }
}
