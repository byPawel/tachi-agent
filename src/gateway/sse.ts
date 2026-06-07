// src/gateway/sse.ts
import type { GatewayEvent } from "./types.js";

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
} as const;

/**
 * Format one SSE frame.
 *
 * `seq` is the registry's durable, monotonic per-run sequence number (NOT an
 * array index) — it is emitted as the SSE `id:` so a reconnecting client can
 * resume with `Last-Event-ID: <seq>`. Heartbeats pass no `seq` and therefore
 * carry no `id:`, so they never advance the client's resume point.
 */
export function formatSse(event: GatewayEvent, seq?: number): string {
  const lines: string[] = [];
  if (seq !== undefined) lines.push(`id: ${seq}`);
  lines.push(`event: ${event.type}`);
  lines.push(`data: ${JSON.stringify(event)}`);
  return lines.join("\n") + "\n\n";
}
