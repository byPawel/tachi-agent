/**
 * Tests for service.ts — macOS launchd integration.
 * Pure parts (plist/env/path generation) tested directly; the impure shell
 * (install/uninstall/status) tested with injected deps + temp-dir home.
 * TDD: written before the implementation.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, stat, chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generatePlist,
  parseEnvFile,
  servicePaths,
  resolveDaemonPath,
  serviceInstall,
  serviceUninstall,
  serviceStatus,
  type ServiceDeps,
} from "../service.js";

// ---------------------------------------------------------------------------
// generatePlist
// ---------------------------------------------------------------------------

describe("generatePlist", () => {
  const plist = generatePlist({
    nodePath: "/abs/node",
    daemonPath: "/abs/dist/daemon/index.js",
    cwd: "/Users/u/.tachi-agent",
    logDir: "/Users/u/Library/Logs/tachi-agent",
    env: { GATEWAY_TOKEN: "t", TACHI_DAEMON_PORT: "8787" },
  });

  it("uses absolute node + daemon paths in ProgramArguments", () => {
    expect(plist).toContain("<string>/abs/node</string>");
    expect(plist).toContain("<string>/abs/dist/daemon/index.js</string>");
  });

  it("embeds env, cwd, KeepAlive, RunAtLoad, and log paths", () => {
    expect(plist).toContain("<key>GATEWAY_TOKEN</key>");
    expect(plist).toContain("<key>TACHI_DAEMON_PORT</key>");
    expect(plist).toContain("<string>/Users/u/.tachi-agent</string>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("daemon.log");
  });

  it("carries the launchd label", () => {
    expect(plist).toContain("<string>com.tachi-agent.daemon</string>");
  });

  it("XML-escapes env values", () => {
    const p = generatePlist({
      nodePath: "/n",
      daemonPath: "/d",
      cwd: "/c",
      logDir: "/l",
      env: { X: "a<b&c" },
    });
    expect(p).toContain("a&lt;b&amp;c");
  });
});

// ---------------------------------------------------------------------------
// parseEnvFile
// ---------------------------------------------------------------------------

describe("parseEnvFile", () => {
  it("parses KEY=VALUE lines, ignores comments/blanks/exports, strips quotes", () => {
    expect(parseEnvFile('# c\nexport A=1\nB="two words"\n\nC=x=y')).toEqual({
      A: "1",
      B: "two words",
      C: "x=y",
    });
  });

  it("strips single quotes too and trims whitespace around keys", () => {
    expect(parseEnvFile("  D = 'val'  ")).toEqual({ D: "val" });
  });

  it("skips lines without =", () => {
    expect(parseEnvFile("not-an-assignment\nE=5")).toEqual({ E: "5" });
  });

  it("strips CRLF line endings (Windows-edited .env files)", () => {
    expect(parseEnvFile("A=1\r\nB=two\r\n")).toEqual({ A: "1", B: "two" });
  });
});

// ---------------------------------------------------------------------------
// servicePaths
// ---------------------------------------------------------------------------

describe("servicePaths", () => {
  it("derives label, plist path under LaunchAgents, log dir", () => {
    const p = servicePaths("/Users/u");
    expect(p.label).toBe("com.tachi-agent.daemon");
    expect(p.plist).toBe("/Users/u/Library/LaunchAgents/com.tachi-agent.daemon.plist");
    expect(p.logDir).toBe("/Users/u/Library/Logs/tachi-agent");
  });

  it("default working directory is ~/.tachi-agent", () => {
    expect(servicePaths("/Users/u").defaultCwd).toBe("/Users/u/.tachi-agent");
  });
});

// ---------------------------------------------------------------------------
// resolveDaemonPath — built-layout resolver (dist/service.js → dist/daemon/index.js)
// ---------------------------------------------------------------------------

describe("resolveDaemonPath", () => {
  it("resolves ./daemon/index.js next to the built module", () => {
    expect(resolveDaemonPath("file:///app/dist/service.js")).toBe("/app/dist/daemon/index.js");
  });
});

// ---------------------------------------------------------------------------
// Impure shell — injected deps + temp home
// ---------------------------------------------------------------------------

interface ExecCall {
  cmd: string;
  args: string[];
}

function makeDeps(
  home: string,
  overrides: Partial<ServiceDeps> = {},
): ServiceDeps & { out: string[]; err: string[]; calls: ExecCall[] } {
  const out: string[] = [];
  const err: string[] = [];
  const calls: ExecCall[] = [];
  return {
    platform: "darwin",
    home,
    env: { GATEWAY_TOKEN: "env-token" },
    uid: 501,
    execPath: "/abs/node",
    daemonPath: "/abs/dist/daemon/index.js",
    execFile: async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return { code: 0, stdout: "", stderr: "" };
    },
    stdout: (l: string) => out.push(l),
    stderr: (l: string) => err.push(l),
    out,
    err,
    calls,
    ...overrides,
  };
}

describe("serviceInstall", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "tachi-svc-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("refuses on non-darwin with the README systemd pointer", async () => {
    const deps = makeDeps(home, { platform: "linux" });
    await expect(serviceInstall(deps, {})).rejects.toThrow(/systemd.*README|README.*systemd/);
  });

  it("requires GATEWAY_TOKEN (env or --env-file)", async () => {
    const deps = makeDeps(home, { env: {} });
    await expect(serviceInstall(deps, {})).rejects.toThrow(/GATEWAY_TOKEN/);
  });

  it("writes the plist with mode 0600 and bootstraps via launchctl", async () => {
    const deps = makeDeps(home);
    await serviceInstall(deps, {});

    const { plist, label, logDir, defaultCwd } = servicePaths(home);
    const st = await stat(plist);
    expect(st.mode & 0o777).toBe(0o600);

    const content = await readFile(plist, "utf8");
    expect(content).toContain("env-token");
    expect(content).toContain("<string>/abs/node</string>");
    expect(content).toContain("<string>/abs/dist/daemon/index.js</string>");

    // cwd + logDir created
    expect((await stat(defaultCwd)).isDirectory()).toBe(true);
    expect((await stat(logDir)).isDirectory()).toBe(true);

    // bootout (ignore failure) then bootstrap
    expect(deps.calls).toEqual([
      { cmd: "launchctl", args: ["bootout", `gui/501/${label}`] },
      { cmd: "launchctl", args: ["bootstrap", "gui/501", plist] },
    ]);
    expect(deps.out.join("\n")).toContain("service status");
  });

  it("chmods an existing plist back to 0600 when overwriting", async () => {
    const { plist } = servicePaths(home);
    await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(plist, "old", { mode: 0o644 });
    await chmod(plist, 0o644);

    const deps = makeDeps(home);
    await serviceInstall(deps, {});
    expect(((await stat(plist)).mode) & 0o777).toBe(0o600);
  });

  it("ignores bootout failure but fails on bootstrap failure", async () => {
    const deps = makeDeps(home, {
      execFile: async (cmd: string, args: string[]) => {
        if (args[0] === "bootout") return { code: 3, stdout: "", stderr: "not loaded" };
        return { code: 1, stdout: "", stderr: "bootstrap boom" };
      },
    });
    await expect(serviceInstall(deps, {})).rejects.toThrow(/bootstrap boom/);
  });

  it("merges --env-file values over process env and embeds them", async () => {
    const envFile = join(home, ".env");
    await writeFile(envFile, "GATEWAY_TOKEN=file-token\nTACHI_DAEMON_PORT=9999\n", { mode: 0o600 });
    await chmod(envFile, 0o600);

    const deps = makeDeps(home);
    await serviceInstall(deps, { envFile });
    const content = await readFile(servicePaths(home).plist, "utf8");
    expect(content).toContain("file-token");
    expect(content).not.toContain("env-token");
    expect(content).toContain("9999");
  });

  it("warns when the --env-file is group/world-readable", async () => {
    const envFile = join(home, ".env");
    await writeFile(envFile, "GATEWAY_TOKEN=t\n");
    await chmod(envFile, 0o644);

    const deps = makeDeps(home);
    await serviceInstall(deps, { envFile });
    expect(deps.err.join("\n")).toContain(`chmod 600 ${envFile}`);
  });

  it("does not warn for a 0600 env-file", async () => {
    const envFile = join(home, ".env");
    await writeFile(envFile, "GATEWAY_TOKEN=t\n");
    await chmod(envFile, 0o600);

    const deps = makeDeps(home);
    await serviceInstall(deps, { envFile });
    expect(deps.err.join("\n")).not.toContain("chmod 600");
  });

  it("honours --cwd over the default working directory", async () => {
    const customCwd = join(home, "custom-cwd");
    const deps = makeDeps(home);
    await serviceInstall(deps, { cwd: customCwd });
    const content = await readFile(servicePaths(home).plist, "utf8");
    expect(content).toContain(`<string>${customCwd}</string>`);
    expect((await stat(customCwd)).isDirectory()).toBe(true);
  });
});

describe("serviceUninstall", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "tachi-svc-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("refuses on non-darwin", async () => {
    const deps = makeDeps(home, { platform: "win32" });
    await expect(serviceUninstall(deps)).rejects.toThrow(/macOS/);
  });

  it("boots out and removes the plist", async () => {
    const { plist, label } = servicePaths(home);
    await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(plist, "x");

    const deps = makeDeps(home);
    await serviceUninstall(deps);
    expect(deps.calls).toEqual([{ cmd: "launchctl", args: ["bootout", `gui/501/${label}`] }]);
    await expect(stat(plist)).rejects.toThrow();
    expect(deps.out.join("\n")).toContain("removed");
  });

  it("is fail-soft when nothing is installed", async () => {
    const deps = makeDeps(home, {
      execFile: async () => ({ code: 3, stdout: "", stderr: "not loaded" }),
    });
    await expect(serviceUninstall(deps)).resolves.toBeUndefined();
    expect(deps.out.join("\n")).toContain("nothing to remove");
  });
});

describe("serviceStatus", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "tachi-svc-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("refuses on non-darwin", async () => {
    const deps = makeDeps(home, { platform: "linux" });
    await expect(serviceStatus(deps)).rejects.toThrow(/macOS/);
  });

  it("reports running with the parsed state line", async () => {
    const deps = makeDeps(home, {
      execFile: async () => ({
        code: 0,
        stdout: "com.tachi-agent.daemon = {\n\tstate = running\n\tpid = 4242\n}",
        stderr: "",
      }),
    });
    await serviceStatus(deps);
    const text = deps.out.join("\n");
    expect(text).toContain("com.tachi-agent.daemon");
    expect(text).toContain("running");
  });

  it("reports not-loaded with an install hint when launchctl print fails", async () => {
    const deps = makeDeps(home, {
      execFile: async () => ({ code: 113, stdout: "", stderr: "Could not find service" }),
    });
    await serviceStatus(deps);
    const text = deps.out.join("\n");
    expect(text).toContain("not loaded");
    expect(text).toContain("service install");
  });
});
