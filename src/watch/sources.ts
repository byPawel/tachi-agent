/**
 * tachi-watch — live sources. Both are fail-soft and self-healing: a missing
 * transcript is waited for, a dead tachibot is replaced by the next one that
 * registers. Neither ever throws into the watcher.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { parseClaudeEntry, parseTraceEvent, tachibotTraceDir, type TachibotTraceEvent, type WatchEvent } from "./events.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Resolve on the next write to `file` (fs.watch) or after `ms`, whichever first. */
function changed(file: string, ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let watcher: fs.FSWatcher | undefined;
    const done = () => {
      clearTimeout(timer);
      watcher?.close();
      resolve();
    };
    const timer = setTimeout(done, ms);
    try {
      watcher = fs.watch(file, { persistent: false, signal }, done);
      watcher.on("error", () => undefined);
    } catch {
      // file missing or watch unsupported — the timer covers it
    }
  });
}

/**
 * Follow a JSONL file (poll-based: fs.watch is unreliable across editors/FSes).
 * Starts `backfillBytes` before the end so the watcher has some context.
 */
export async function tailClaudeTranscript(
  file: string,
  onEvent: (e: WatchEvent) => void,
  signal: AbortSignal,
  // whole session on start: screenshots make transcripts huge, and tachibot calls
  // from minutes ago can sit many MB back (parsing 64MB of JSONL takes well under a second)
  backfillBytes = 64 * 1024 * 1024,
): Promise<void> {
  let offset = -1;
  let partial = "";
  while (!signal.aborted) {
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      await sleep(1000); // session file not created yet
      continue;
    }
    if (offset < 0) {
      offset = Math.max(0, size - backfillBytes);
      partial = "";
      if (offset > 0) partial = "\u0000"; // marks "drop the first, cut-off line"
    }
    if (size < offset) offset = 0; // truncated/rotated
    if (size > offset) {
      const fd = fs.openSync(file, "r");
      try {
        const buf = Buffer.alloc(size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset);
        offset = size;
        let text = (partial === "\u0000" ? "" : partial) + buf.toString("utf8");
        if (partial === "\u0000") text = text.slice(text.indexOf("\n") + 1);
        const lines = text.split("\n");
        partial = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            for (const e of parseClaudeEntry(JSON.parse(line))) onEvent(e);
          } catch {
            // half-written or unknown line
          }
        }
      } finally {
        fs.closeSync(fd);
      }
    }
    await changed(file, 250, signal); // wake on write, poll as fallback
  }
}

interface TraceRegistryEntry {
  pid: number;
  /** tachibot's parent — the MCP client (Claude Code) that spawned it. */
  ppid?: number;
  port: number;
  token: string;
  cwd: string;
  startedAt: number;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The live tachibot trace server that belongs to this Claude session, or none.
 *
 * Only the tachibot that this Claude spawned (its parent pid is `claudePid`) qualifies.
 * Without `claudePid` there is no way to prove whose a trace is — a tachibot in the same
 * project may be another session's — so none is followed. `watch --open` always passes it,
 * and so does the command it prints for a pane you split yourself.
 *
 * Never "the newest one on the machine": a tachibot only registers at its first traced
 * call, so until this session makes one, the newest is some other session's — and the
 * pane would list, and the second brain would review, that session's calls.
 */
export function findTachibot(cwd: string, dir: string = tachibotTraceDir(), claudePid?: number): TraceRegistryEntry | undefined {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return undefined;
  }
  const live: TraceRegistryEntry[] = [];
  for (const f of files) {
    try {
      const e = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as TraceRegistryEntry;
      if (alive(e.pid)) live.push(e);
    } catch {
      // ignore
    }
  }
  if (!claudePid) return undefined;
  // newest first: a registry file left by a dead tachibot whose pid was reused never outranks the real one
  return live.filter((e) => e.ppid === claudePid).sort((x, y) => y.startedAt - x.startedAt)[0];
}

function streamOnce(entry: TraceRegistryEntry, onEvent: (e: WatchEvent) => void, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port: entry.port, path: `/events?t=${entry.token}`, headers: { Host: `127.0.0.1:${entry.port}` }, signal },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve();
          return;
        }
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buf += chunk;
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            if (!frame.startsWith("data: ")) continue;
            try {
              const e = parseTraceEvent(JSON.parse(frame.slice(6)) as TachibotTraceEvent);
              if (e) onEvent(e);
            } catch {
              // malformed frame
            }
          }
        });
        res.on("end", resolve);
        res.on("error", () => resolve());
      },
    );
    // a port that accepts but never answers (a stale entry whose port something else took) must not hold the loop
    req.setTimeout(5000, () => req.destroy());
    req.on("response", () => req.setTimeout(0));
    req.on("error", () => resolve());
  });
}

/**
 * Follow tachibot's trace stream, reconnecting to whichever tachibot is live.
 * `onStatus` reports connect/disconnect for the pane header.
 */
export async function followTachibot(
  cwd: string,
  onEvent: (e: WatchEvent) => void,
  onStatus: (s: string) => void,
  signal: AbortSignal,
  claudePid?: number,
): Promise<void> {
  let last: string | undefined;
  // what each server has already shown us, by event identity: a reconnect replays its buffer,
  // and two different events can carry the same timestamp
  const shown = new Map<string, Set<string>>();
  let announcedMissing = false;
  while (!signal.aborted) {
    const entry = findTachibot(cwd, tachibotTraceDir(), claudePid);
    if (!entry) {
      if (!announcedMissing) {
        onStatus(claudePid
          ? "tachibot: not traced yet (needs TACHIBOT_TRACE_UI=1 and one tachibot call)"
          : "tachibot: model trace needs Claude's pid — open the pane with `watch --open`");
        announcedMissing = true;
      }
      await sleep(2000);
      continue;
    }
    announcedMissing = false;
    // The first connect to a server shows its replayed buffer (useful context); a reconnect skips what was shown.
    const server = `${entry.pid}:${entry.port}:${entry.startedAt}`;
    if (server !== last) {
      onStatus(`tachibot: connected (pid ${entry.pid})`);
      last = server;
    }
    let seen = shown.get(server);
    if (!seen) shown.set(server, (seen = new Set()));
    // While streaming, keep asking whose trace this should be: when the answer changes
    // (this session's own tachibot registered, or a second session made the choice ambiguous) drop the stream.
    const stream = new AbortController();
    const stop = () => stream.abort();
    signal.addEventListener("abort", stop);
    const recheck = setInterval(() => {
      if (findTachibot(cwd, tachibotTraceDir(), claudePid)?.pid !== entry.pid) stream.abort();
    }, 3000);
    await streamOnce(entry, (e) => {
      const key = `${e.id ?? ""}|${e.kind}|${e.ts}|${e.text.length}`;
      if (seen.has(key)) return;
      if (seen.size > 50_000) seen.clear(); // a very long session: a rare repeat beats unbounded memory
      seen.add(key);
      onEvent(e);
    }, stream.signal);
    clearInterval(recheck);
    signal.removeEventListener("abort", stop);
    await sleep(1000);
  }
}
