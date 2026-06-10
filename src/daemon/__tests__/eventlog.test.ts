import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunEventLog } from "../eventlog.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "tachi-eventlog-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("RunEventLog", () => {
  it("appends and reads back events in order with seq and ts", async () => {
    const log = new RunEventLog({ dir, now: () => 1234 });
    await log.append("run-1", 1, { type: "step", iteration: 1 });
    await log.append("run-1", 2, { type: "final", answer: "ok", haltedBy: "final-answer" });
    const entries = await log.read("run-1");
    expect(entries).toEqual([
      { seq: 1, ts: 1234, event: { type: "step", iteration: 1 } },
      { seq: 2, ts: 1234, event: { type: "final", answer: "ok", haltedBy: "final-answer" } },
    ]);
  });

  it("returns [] for an unknown run", async () => {
    const log = new RunEventLog({ dir });
    expect(await log.read("nope")).toEqual([]);
  });

  it("skips corrupt lines instead of throwing (crash-truncated tail)", async () => {
    const log = new RunEventLog({ dir, now: () => 1 });
    await log.append("run-2", 1, { type: "step", iteration: 1 });
    await appendFile(join(dir, "run-2.jsonl"), '{"seq":2,"ts":1,"event":{"type"');
    const entries = await log.read("run-2");
    expect(entries.length).toBe(1);
    expect(entries[0].seq).toBe(1);
  });

  it("lists run ids from filenames", async () => {
    const log = new RunEventLog({ dir, now: () => 1 });
    await log.append("aaa", 1, { type: "heartbeat" });
    await log.append("bbb", 1, { type: "heartbeat" });
    expect((await log.list()).sort()).toEqual(["aaa", "bbb"]);
  });

  it("rejects path-traversal run ids", async () => {
    const log = new RunEventLog({ dir });
    await expect(log.append("../evil", 1, { type: "heartbeat" })).rejects.toThrow(/run id/);
  });
});
