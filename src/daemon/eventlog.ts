/**
 * RunEventLog — durable, append-only JSONL event log per run.
 *
 * The gateway's in-memory ring buffer serves live SSE replay; THIS log is the
 * durable record: it survives daemon restarts and crashes, giving forensics
 * ("why did that unattended run go sideways?") and replay. One file per run:
 * `<dir>/<runId>.jsonl`, one `{seq, ts, event}` JSON object per line.
 *
 * Writes are fire-and-forget from the caller's perspective (the gateway must
 * never block or throw on logging); a torn final line from a crash is tolerated
 * on read. Config: TACHI_RUN_LOG_DIR (default ".tachi/runs").
 */
import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { GatewayEvent } from "../gateway/types.js";

export interface LoggedEvent {
  seq: number;
  ts: number;
  event: GatewayEvent;
}

const SAFE_RUN_ID = /^[A-Za-z0-9-]+$/; // registry ids are UUIDs; refuse anything else

export class RunEventLog {
  private readonly dir: string;
  private readonly now: () => number;
  private mkdirDone: Promise<unknown> | undefined;

  constructor(opts: { dir?: string; now?: () => number } = {}) {
    this.dir = opts.dir ?? process.env.TACHI_RUN_LOG_DIR ?? ".tachi/runs";
    this.now = opts.now ?? Date.now;
  }

  private file(runId: string): string {
    if (!SAFE_RUN_ID.test(runId)) throw new Error(`invalid run id: ${runId}`);
    return join(this.dir, `${runId}.jsonl`);
  }

  /** Append one event line. Creates the directory on first use. */
  async append(runId: string, seq: number, event: GatewayEvent): Promise<void> {
    const file = this.file(runId); // validate BEFORE any I/O
    this.mkdirDone ??= mkdir(this.dir, { recursive: true });
    await this.mkdirDone;
    const entry: LoggedEvent = { seq, ts: this.now(), event };
    await appendFile(file, JSON.stringify(entry) + "\n", "utf8");
  }

  /** All logged events for a run, in file order. Missing file → []; corrupt lines skipped. */
  async read(runId: string): Promise<LoggedEvent[]> {
    let raw: string;
    try {
      raw = await readFile(this.file(runId), "utf8");
    } catch {
      return [];
    }
    const entries: LoggedEvent[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line) as LoggedEvent); } catch { /* torn tail from a crash */ }
    }
    return entries;
  }

  /** Run ids that have a log file. */
  async list(): Promise<string[]> {
    try {
      const names = await readdir(this.dir);
      return names.filter((n) => n.endsWith(".jsonl")).map((n) => n.slice(0, -".jsonl".length));
    } catch {
      return [];
    }
  }
}
