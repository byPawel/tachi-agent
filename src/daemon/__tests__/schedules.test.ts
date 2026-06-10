import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskQueue } from "../queue.js";
import { Schedules } from "../schedules.js";

let dir: string;
let defsFile: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tachi-schedules-"));
  defsFile = join(dir, "schedules.json");
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const writeDefs = (schedules: unknown[]) =>
  writeFile(defsFile, JSON.stringify({ schedules }, null, 2), "utf8");

const openQueue = (now: () => number) => TaskQueue.open({ file: join(dir, "q.json"), now });

/** Epoch ms for a LOCAL wall-clock time (the schedule due logic is local-time based). */
const local = (h: number, m: number, day = 5) => new Date(2026, 0, day, h, m).getTime();

describe("Schedules", () => {
  it("daily fires once after the time passes, not again the same day, and again the next day", async () => {
    await writeDefs([{ id: "digest", task: "morning digest", driver: "openai", kind: "daily", at: "07:00" }]);
    let now = local(6, 30);
    const clock = () => now;
    const queue = await openQueue(clock);
    const s = new Schedules({ file: defsFile, now: clock });

    expect(await s.tick(queue)).toEqual([]);          // 06:30 — before 07:00, not due

    now = local(7, 1);
    const fired = await s.tick(queue);                 // 07:01 — due
    expect(fired.map((t) => t.task)).toEqual(["morning digest"]);
    expect(fired[0].driver).toBe("openai");            // driver passes through

    now = local(9, 0);
    expect(await s.tick(queue)).toEqual([]);           // same day — already ran

    now = local(7, 1) + 24 * 3_600_000;                // next day, 07:01
    expect((await s.tick(queue)).length).toBe(1);      // fires again
  });

  it("every-N fires on the first tick, then again only after N minutes", async () => {
    await writeDefs([{ id: "poll", task: "poll feed", kind: "every", everyMinutes: 30 }]);
    let now = local(10, 0);
    const clock = () => now;
    const queue = await openQueue(clock);
    const s = new Schedules({ file: defsFile, now: clock });

    expect((await s.tick(queue)).length).toBe(1);      // never ran → due immediately
    now += 29 * 60_000;
    expect(await s.tick(queue)).toEqual([]);           // 29 min — not yet
    now += 1 * 60_000;
    expect((await s.tick(queue)).length).toBe(1);      // 30 min — due again
  });

  it("hand-editing the definitions file between ticks takes effect without restart", async () => {
    await writeDefs([{ id: "a", task: "task a", kind: "every", everyMinutes: 5 }]);
    let now = local(10, 0);
    const clock = () => now;
    const queue = await openQueue(clock);
    const s = new Schedules({ file: defsFile, now: clock });

    expect((await s.tick(queue)).map((t) => t.task)).toEqual(["task a"]);
    expect(s.list().map((d) => d.id)).toEqual(["a"]);

    // The human edits the file: a new schedule appears.
    await writeDefs([
      { id: "a", task: "task a", kind: "every", everyMinutes: 5 },
      { id: "b", task: "task b", kind: "every", everyMinutes: 5 },
    ]);
    now += 60_000; // a not due yet (5 min), b never ran → due
    expect((await s.tick(queue)).map((t) => t.task)).toEqual(["task b"]);
    expect(s.list().map((d) => d.id)).toEqual(["a", "b"]);
  });

  it("skips malformed entries with a warn, never throws, and still runs valid siblings", async () => {
    await writeDefs([
      { id: "bad-at", task: "x", kind: "daily", at: "25:99" },          // invalid time
      { id: "bad-every", task: "y", kind: "every", everyMinutes: -3 },  // invalid interval
      { kind: "every", everyMinutes: 1 },                                // missing id/task
      { id: "ok", task: "good one", kind: "every", everyMinutes: 1 },
    ]);
    const now = local(12, 0);
    const queue = await openQueue(() => now);
    const s = new Schedules({ file: defsFile, now: () => now });

    const fired = await s.tick(queue);
    expect(fired.map((t) => t.task)).toEqual(["good one"]);
  });

  it("missing definitions file → no-op (returns nothing, never throws)", async () => {
    const queue = await openQueue(() => local(12, 0));
    const s = new Schedules({ file: join(dir, "nope.json"), now: () => local(12, 0) });
    expect(await s.tick(queue)).toEqual([]);
    expect(s.list()).toEqual([]);
  });

  it("persists lastRunAt to the separate state file so a restart does not refire", async () => {
    await writeDefs([{ id: "digest", task: "digest", kind: "daily", at: "07:00" }]);
    const now = local(8, 0);
    const queue = await openQueue(() => now);
    const s1 = new Schedules({ file: defsFile, now: () => now });
    expect((await s1.tick(queue)).length).toBe(1);

    // State lives next to the defs file, in OUR file — user edits stay separate.
    const state = JSON.parse(await readFile(join(dir, "schedules-state.json"), "utf8"));
    expect(state.lastRunAt.digest).toBe(now);

    const s2 = new Schedules({ file: defsFile, now: () => now }); // simulated restart
    expect(await s2.tick(queue)).toEqual([]);                     // already ran today
  });
});
