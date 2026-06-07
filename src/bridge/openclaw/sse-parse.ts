// src/bridge/openclaw/sse-parse.ts
/**
 * Incremental Server-Sent-Events frame parser — pure, no I/O.
 *
 * Consumes string chunks (call `push()` per chunk) and returns the SSE frames
 * that became complete. A frame is the text between blank lines (`\n\n`); we
 * read its `event:` and `data:` fields. Matches exactly what the gateway's
 * `formatSse()` emits (`id:`/`event:`/`data:` lines, blank-line terminated).
 * `id:` is ignored here (replay/reconnect is a client concern, not the parser's).
 */

/** A decoded SSE frame: the event name and the raw (single-line JSON) data payload. */
export interface SseFrame {
  event: string;
  /** The concatenated `data:` payload (the gateway emits one line of JSON). */
  data: string;
  /** The `id:` value (the durable seq), if present — drives Last-Event-ID resume. */
  id?: number;
}

export class SseFrameParser {
  private buffer = "";

  /** Feed a chunk; returns the frames that completed within (and before) it. */
  push(chunk: string): SseFrame[] {
    this.buffer += chunk.replace(/\r\n/g, "\n"); // normalize CRLF → LF
    const frames: SseFrame[] = [];
    let sep = this.buffer.indexOf("\n\n");
    while (sep !== -1) {
      const block = this.buffer.slice(0, sep);
      this.buffer = this.buffer.slice(sep + 2);
      const frame = this.decode(block);
      if (frame) frames.push(frame);
      sep = this.buffer.indexOf("\n\n");
    }
    return frames;
  }

  /** Decode one frame block into `{ event, data, id? }`, or null if it carries no data. */
  private decode(block: string): SseFrame | null {
    let event = "message"; // SSE default when no `event:` line is present
    let id: number | undefined;
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
      else if (line.startsWith("id:")) {
        const n = Number(line.slice(3).trim());
        if (Number.isFinite(n)) id = n;
      }
    }
    if (dataLines.length === 0) return null;
    return id === undefined ? { event, data: dataLines.join("\n") } : { event, data: dataLines.join("\n"), id };
  }
}
