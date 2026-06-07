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

  /** Decode one frame block into `{ event, data }`, or null if it carries no data. */
  private decode(block: string): SseFrame | null {
    let event = "message"; // SSE default when no `event:` line is present
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
      // `id:` and any other field are ignored
    }
    if (dataLines.length === 0) return null;
    return { event, data: dataLines.join("\n") };
  }
}
