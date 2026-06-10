import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createGatewayServer } from "../server.js";
import { TaskQueue } from "../../daemon/queue.js";

const fakeRuntime = { orchestrator: () => ({ run: async () => ({ answer: "", iterations: 0, toolCalls: [], haltedBy: "final-answer" as const, costUsd: 0 }) }) } as any;

let dir: string;
let queue: TaskQueue;
let server: ReturnType<typeof createGatewayServer> | undefined;
let base: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tachi-tasks-"));
  queue = await TaskQueue.open({ file: join(dir, "q.json") });
  server = createGatewayServer(fakeRuntime, { env: { GATEWAY_TOKEN: "t" }, queue });
  await new Promise<void>((r) => server!.listen(0, r));
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
});
afterEach(async () => { server?.close(); await rm(dir, { recursive: true, force: true }); });

const auth = { "Content-Type": "application/json", Authorization: "Bearer t" };

describe("/tasks endpoints", () => {
  it("POST /tasks enqueues and returns 202 with the task id", async () => {
    const res = await fetch(`${base}/tasks`, { method: "POST", headers: auth, body: JSON.stringify({ task: "nightly digest" }) });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { task_id: string; status: string };
    expect(body.status).toBe("queued");
    expect(queue.get(body.task_id)?.task).toBe("nightly digest");
  });

  it("POST /tasks validates: empty task → 400", async () => {
    const res = await fetch(`${base}/tasks`, { method: "POST", headers: auth, body: JSON.stringify({}) });
    expect(res.status).toBe(400);
  });

  it("GET /tasks lists, GET /tasks/:id returns one, unknown id → 404", async () => {
    const t = queue.enqueue("listed");
    const list = await fetch(`${base}/tasks`, { headers: auth });
    expect(list.status).toBe(200);
    expect(((await list.json()) as any).tasks.map((x: any) => x.id)).toContain(t.id);

    const one = await fetch(`${base}/tasks/${t.id}`, { headers: auth });
    expect(one.status).toBe(200);
    expect(((await one.json()) as any).task).toBe("listed");

    const missing = await fetch(`${base}/tasks/nope`, { headers: auth });
    expect(missing.status).toBe(404);
  });

  it("POST /tasks with a driver stores it; GET /tasks/:id and the list show it", async () => {
    const res = await fetch(`${base}/tasks`, { method: "POST", headers: auth, body: JSON.stringify({ task: "cloud job", driver: "openai" }) });
    expect(res.status).toBe(202);
    const { task_id } = (await res.json()) as { task_id: string };

    const one = await fetch(`${base}/tasks/${task_id}`, { headers: auth });
    expect(((await one.json()) as any).driver).toBe("openai");

    const list = await fetch(`${base}/tasks`, { headers: auth });
    const entry = ((await list.json()) as any).tasks.find((x: any) => x.id === task_id);
    expect(entry.driver).toBe("openai");
  });

  it("POST /tasks with a non-string driver → 400", async () => {
    const res = await fetch(`${base}/tasks`, { method: "POST", headers: auth, body: JSON.stringify({ task: "bad", driver: 123 }) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe("driver must be a string");
  });

  it("without a queue configured, /tasks is 404 (bare gateway unchanged)", async () => {
    const bare = createGatewayServer(fakeRuntime, { env: { GATEWAY_TOKEN: "t" } });
    await new Promise<void>((r) => bare.listen(0, r));
    const port = (bare.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/tasks`, { headers: auth });
    expect(res.status).toBe(404);
    bare.close();
  });
});
