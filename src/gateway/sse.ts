// src/gateway/sse.ts
import type { GatewayEvent } from "./types.js";

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
} as const;

/** Format one SSE frame. `id` (the event index) enables Last-Event-ID replay. */
export function formatSse(event: GatewayEvent, id?: number): string {
  const lines: string[] = [];
  if (id !== undefined) lines.push(`id: ${id}`);
  lines.push(`event: ${event.type}`);
  lines.push(`data: ${JSON.stringify(event)}`);
  return lines.join("\n") + "\n\n";
}
