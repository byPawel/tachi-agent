// src/gateway/registry.ts
import { randomUUID } from "node:crypto";
import type { GatewayEvent, RunRecord, RunStatus } from "./types.js";
import type { RunResult } from "../types.js";

type Subscriber = (event: GatewayEvent, index: number) => void;

export class RunRegistry {
  private runs = new Map<string, RunRecord>();
  private subs = new Map<string, Set<Subscriber>>();

  create(tenant: string, task: string): RunRecord {
    const record: RunRecord = {
      id: randomUUID(),
      tenant,
      task,
      status: "running",
      events: [],
      controller: new AbortController(),
    };
    this.runs.set(record.id, record);
    return record;
  }

  get(id: string): RunRecord | undefined {
    return this.runs.get(id);
  }

  list(tenant: string): RunRecord[] {
    return [...this.runs.values()].filter((r) => r.tenant === tenant);
  }

  append(id: string, event: GatewayEvent): void {
    const record = this.runs.get(id);
    if (!record) return;
    const index = record.events.push(event) - 1;
    const set = this.subs.get(id);
    if (set) for (const cb of set) cb(event, index);
  }

  subscribe(id: string, cb: Subscriber): () => void {
    let set = this.subs.get(id);
    if (!set) { set = new Set(); this.subs.set(id, set); }
    set.add(cb);
    return () => { set!.delete(cb); };
  }

  finish(id: string, status: RunStatus, result?: RunResult, error?: string): void {
    const record = this.runs.get(id);
    if (!record) return;
    record.status = status;
    if (result) record.result = result;
    if (error) record.error = error;
  }

  abort(id: string): boolean {
    const record = this.runs.get(id);
    if (!record) return false;
    record.controller.abort();
    if (record.status === "running") record.status = "aborted";
    return true;
  }
}
