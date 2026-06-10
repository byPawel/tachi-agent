/**
 * cli-commands.ts — queue/run visibility subcommands for tachi-agent.
 *
 * All logic is pure and testable via injected deps (CliDeps).
 * cli.ts delegates here so this module has no process.* side-effects of its own.
 */
import { RunEventLog } from "./daemon/eventlog.js";
import type { GatewayEvent } from "./gateway/types.js";

// ---------------------------------------------------------------------------
// Dependency injection surface
// ---------------------------------------------------------------------------

export interface CliDeps {
  env: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
  stdout: (line: string) => void;
}

// ---------------------------------------------------------------------------
// Parsed CLI shape
// ---------------------------------------------------------------------------

export type ParsedCliArgs =
  | { command: "task-add"; text: string; driver?: string; maxAttempts?: number }
  | { command: "task-list" }
  | { command: "task-show"; id: string }
  | { command: "runs-log"; id: string }
  | { command: "run"; text: string };

// ---------------------------------------------------------------------------
// parseCliArgs
// ---------------------------------------------------------------------------

/**
 * Parse process.argv.slice(2) into a typed command descriptor.
 *
 * Recognised shapes:
 *   task add <text...> [--driver <name>] [--max-attempts <n>]
 *   task list
 *   task show <id>
 *   runs log <id>
 *   <anything else>  →  { command: "run", text: argv.join(" ") }
 */
export function parseCliArgs(argv: string[]): ParsedCliArgs {
  const [first, second, ...rest] = argv;

  if (first === "task" && second === "list") {
    return { command: "task-list" };
  }

  if (first === "task" && second === "show") {
    return { command: "task-show", id: rest[0] ?? "" };
  }

  if (first === "runs" && second === "log") {
    return { command: "runs-log", id: rest[0] ?? "" };
  }

  if (first === "task" && second === "add") {
    // Extract flags anywhere in the remaining tokens
    let driver: string | undefined;
    let maxAttempts: number | undefined;
    const textTokens: string[] = [];

    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--driver" && rest[i + 1] !== undefined) {
        driver = rest[++i];
      } else if (rest[i] === "--max-attempts" && rest[i + 1] !== undefined) {
        maxAttempts = parseInt(rest[++i], 10);
      } else {
        textTokens.push(rest[i]);
      }
    }

    return {
      command: "task-add",
      text: textTokens.join(" "),
      ...(driver !== undefined ? { driver } : {}),
      ...(maxAttempts !== undefined ? { maxAttempts } : {}),
    };
  }

  // Fallback: existing "run a task directly" behaviour
  return { command: "run", text: argv.join(" ") };
}

// ---------------------------------------------------------------------------
// Internal helper — require daemon env vars
// ---------------------------------------------------------------------------

function requireDaemonEnv(env: Record<string, string | undefined>): { baseUrl: string; token: string } {
  const rawUrl = env.TACHI_DAEMON_URL;
  const token = env.GATEWAY_TOKEN;
  if (!rawUrl || !token) {
    throw new Error(
      "task commands need a running daemon: set TACHI_DAEMON_URL and GATEWAY_TOKEN",
    );
  }
  return { baseUrl: rawUrl.replace(/\/+$/, ""), token };
}

// ---------------------------------------------------------------------------
// Internal helper — checked fetch
// ---------------------------------------------------------------------------

async function checkedFetch(
  deps: CliDeps,
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const res = await deps.fetchImpl(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => "(no body)");
    throw new Error(`HTTP ${res.status} from ${url}: ${body}`);
  }
  return res;
}

// ---------------------------------------------------------------------------
// taskAdd
// ---------------------------------------------------------------------------

export async function taskAdd(
  deps: CliDeps,
  text: string,
  opts: { driver?: string; maxAttempts?: number },
): Promise<void> {
  const { baseUrl, token } = requireDaemonEnv(deps.env);

  const bodyObj: Record<string, unknown> = { task: text };
  if (opts.driver !== undefined) bodyObj.driver = opts.driver;
  if (opts.maxAttempts !== undefined) bodyObj.maxAttempts = opts.maxAttempts;

  const res = await checkedFetch(deps, `${baseUrl}/tasks`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(bodyObj),
  });

  const data = (await res.json()) as { task_id: string };
  deps.stdout(`queued ${data.task_id}`);
}

// ---------------------------------------------------------------------------
// taskList
// ---------------------------------------------------------------------------

interface TaskRecord {
  id: string;
  task: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  driver?: string | null;
}

export async function taskList(deps: CliDeps): Promise<void> {
  const { baseUrl, token } = requireDaemonEnv(deps.env);

  const res = await checkedFetch(deps, `${baseUrl}/tasks`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const data = (await res.json()) as { tasks: TaskRecord[] };

  for (const t of data.tasks) {
    const driver = t.driver ?? "default";
    const taskExcerpt = t.task.slice(0, 60);
    deps.stdout(`${t.id}  ${t.status}  attempt ${t.attempts}/${t.maxAttempts}  ${driver}  ${taskExcerpt}`);
  }
}

// ---------------------------------------------------------------------------
// taskShow
// ---------------------------------------------------------------------------

export async function taskShow(deps: CliDeps, id: string): Promise<void> {
  const { baseUrl, token } = requireDaemonEnv(deps.env);

  const res = await checkedFetch(deps, `${baseUrl}/tasks/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const record = await res.json();
  deps.stdout(JSON.stringify(record, null, 2));
}

// ---------------------------------------------------------------------------
// runsLog
// ---------------------------------------------------------------------------

/** Format a compact one-line detail string for a GatewayEvent. */
function formatEventDetail(event: GatewayEvent): string {
  switch (event.type) {
    case "assistant": {
      if (event.toolCalls.length > 0) {
        return event.toolCalls.map((c) => c.name).join(", ");
      }
      return event.content.slice(0, 80);
    }
    case "tool-result":
      return `${event.name}: ${event.result.slice(0, 80)}`;
    case "final":
      return `${event.haltedBy}: ${event.answer.slice(0, 80)}`;
    default:
      // heartbeat, error, shutdown, step, cost — emit the raw type, no extra detail
      return "";
  }
}

export async function runsLog(deps: CliDeps, runId: string): Promise<void> {
  const log = new RunEventLog(
    deps.env.TACHI_RUN_LOG_DIR ? { dir: deps.env.TACHI_RUN_LOG_DIR } : {},
  );
  const events = await log.read(runId);

  if (events.length === 0) {
    deps.stdout(`no events for ${runId}`);
    return;
  }

  for (const { seq, ts, event } of events) {
    const iso = new Date(ts).toISOString();
    const detail = formatEventDetail(event);
    const parts = [String(seq), iso, event.type];
    if (detail) parts.push(detail);
    deps.stdout(parts.join("  "));
  }
}
