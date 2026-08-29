import { describe, expect, it } from "vitest";
import { executeCommand } from "../runner.js";

const aliveAfter = async (pid: number, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return false; // ESRCH — process gone
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return true;
};

describe("executeCommand process-group kill", () => {
  it("kills grandchild processes when the worker times out", async () => {
    // Worker that spawns a long-lived grandchild and then idles: a plain
    // child.kill() would orphan the sleep; the group kill must reap it.
    const script = 'const cp=require("child_process");' +
      'const c=cp.spawn("sleep",["300"]);' +
      'console.log("GRANDCHILD:"+c.pid);' +
      "setInterval(()=>{},1000);";
    const result = await executeCommand(
      {
        command: process.execPath,
        args: ["-e", script],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH },
      },
      { timeoutMs: 1_500, maxOutputChars: 100_000 },
    );

    expect(result.timedOut).toBe(true);
    const match = result.stdout.match(/GRANDCHILD:(\d+)/);
    expect(match).not.toBeNull();
    const grandchildPid = Number(match![1]);
    // SIGTERM is escalated to SIGKILL after 2s; allow the full window.
    expect(await aliveAfter(grandchildPid, 3_000)).toBe(false);
  }, 10_000);
});
