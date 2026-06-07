# OpenClaw Bridge

Delegate a task from **OpenClaw** (peer multi-channel agent gateway) to **tachi-agent**
over tachi-agent's existing HTTP/SSE gateway. OpenClaw is a remote client; the
tachi-agent gateway needs **no** changes.

## 1. Run the tachi-agent gateway

```bash
# minimal single-tenant auth
GATEWAY_TOKEN=supersecret GATEWAY_PORT=8787 npm run gateway
# multi-tenant: GATEWAY_TOKENS="openclaw:tokA,ci:tokB"
```

The gateway exposes:

| Method & path | Purpose |
|---|---|
| `POST /runs` `{ task, maxIterations? }` | start a run → `202 { run_id }` |
| `GET /runs/:id/events` | SSE: `step` / `assistant` / `tool-result` / `cost` / `final` / `error` / `heartbeat` |
| `GET /runs/:id` | poll → `{ status, result, error }` |
| `DELETE /runs/:id` | cooperative cancel |

Auth on every request: `Authorization: Bearer <token>`.

## 2. Use the client from OpenClaw

The bridge ships a zero-dependency client (native `fetch` + `ReadableStream`),
re-exported from the package root:

```ts
import { GatewayClient } from "tachi-agent";

const tachi = new GatewayClient({
  baseUrl: process.env.TACHI_GATEWAY_URL ?? "http://127.0.0.1:8787",
  token: process.env.TACHI_GATEWAY_TOKEN!,
});

// one-call delegation with live progress
const answer = await tachi.runAndWait("research X and summarize", {
  onEvent: (e) => console.error("[tachi]", e.type),
});
```

`runAndWait(task, { maxIterations?, onEvent?, signal? })` returns the final answer
(throws `GatewayHttpError` if the run errors). Lower-level methods: `startRun`,
`streamEvents`, `getStatus`, `cancel`.

## 3. OpenClaw plugin/skill

In OpenClaw, register a skill/tool whose handler calls the bridge. Sketch:

```ts
// openclaw/plugins/tachi-delegate.ts (lives in the OpenClaw repo)
import { GatewayClient } from "tachi-agent";

const tachi = new GatewayClient({
  baseUrl: process.env.TACHI_GATEWAY_URL!,
  token: process.env.TACHI_GATEWAY_TOKEN!,
});

export const tachiDelegate = {
  name: "tachi_delegate",
  description: "Delegate a hard task to tachi-agent's multi-model council.",
  async run(task: string, onProgress?: (line: string) => void): Promise<string> {
    return tachi.runAndWait(task, { onEvent: (e) => onProgress?.(`tachi:${e.type}`) });
  },
};
```

Wire `tachi_delegate` into whichever OpenClaw channels (WhatsApp/Telegram/Slack/
Discord/Signal/iMessage) should be able to escalate to tachi-agent.

## Environment

| Var | Where | Meaning |
|---|---|---|
| `TACHI_GATEWAY_URL` | OpenClaw | gateway base URL (e.g. `http://127.0.0.1:8787`) |
| `TACHI_GATEWAY_TOKEN` | OpenClaw | bearer token (matches a `GATEWAY_TOKEN`/`GATEWAY_TOKENS` entry) |
| `GATEWAY_TOKEN` / `GATEWAY_TOKENS` | tachi-agent | gateway auth |
| `GATEWAY_PORT` | tachi-agent | listen port (default 8787) |

## Not in v1 (follow-ups)

- **SSE reconnect/replay**: the gateway supports `Last-Event-ID` replay from the
  buffered event log; the v1 client reads one continuous stream. Add reconnect by
  tracking the last `id:` and re-issuing `GET /runs/:id/events` with that header.
- **Backpressure**: the client forwards events synchronously to `onEvent`.
