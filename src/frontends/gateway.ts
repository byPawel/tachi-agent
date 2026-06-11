#!/usr/bin/env node
/**
 * tachi-agent gateway — deploy the agent as an HTTP service (async job + SSE).
 * Auth: GATEWAY_TOKEN (single tenant) or GATEWAY_TOKENS="t1:tok1,t2:tok2".
 * Builds the runtime ONCE (singleton) and shares it across all runs.
 */
import { buildAgentFromEnv } from "../runtime.js";
import { createGatewayServer } from "../gateway/server.js";
import { loadUserEnv } from "../env-bootstrap.js";

async function main(): Promise<void> {
  await loadUserEnv(); // ~/.tachi/.env as defaults — real env vars win
  if (!process.env.GATEWAY_TOKEN && !process.env.GATEWAY_TOKENS) {
    console.error("Refusing to start without auth: set GATEWAY_TOKEN or GATEWAY_TOKENS.");
    process.exit(1);
  }
  const runtime = await buildAgentFromEnv(); // singleton — reused across requests
  const port = Number(process.env.GATEWAY_PORT) || 8787;
  const server = createGatewayServer(runtime, { timeoutMs: 120_000 });

  const shutdown = () => server.close(async () => { await runtime.close(); process.exit(0); });
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  server.listen(port, () => console.error(`tachi-agent gateway on :${port} · ${runtime.toolCount} tools`));
}

main().catch((e) => { console.error(e); process.exit(1); });
