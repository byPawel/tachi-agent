// src/bridge/openclaw/index.ts
/**
 * OpenClaw bridge — public surface. OpenClaw imports `GatewayClient` to delegate
 * tasks to a running tachi-agent gateway over HTTP/SSE. No gateway changes needed.
 */
export { GatewayClient, GatewayHttpError } from "./client.js";
export type {
  GatewayClientConfig,
  StartedRun,
  RunState,
  RunOutcome,
} from "./client.js";
export { SseFrameParser } from "./sse-parse.js";
export type { SseFrame } from "./sse-parse.js";
