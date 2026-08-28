/**
 * Tests for setup.ts (first-run wizard) and env-bootstrap.ts.
 * All IO stubbed via SetupDeps; prompt answers are scripted per test.
 */
import { describe, it, expect } from "vitest";

import { runSetup, serializeEnvFile, type SetupDeps } from "../setup.js";
import { applyEnvDefaults, userEnvPath } from "../env-bootstrap.js";
import { parseEnvFile } from "../service.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fetchStub(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) =>
    handler(String(url), init)) as typeof fetch;
}

function tagsResponse(modelNames: string[]): Response {
  return new Response(
    JSON.stringify({ models: modelNames.map((name) => ({ name })) }),
    { status: 200 },
  );
}

interface Harness extends SetupDeps {
  lines: string[];
  written: Map<string, { data: string; mode: number }>;
  commands: string[][];
  serviceInstalls: string[];
  doctorRuns: number;
}

/** Deps with scripted prompt answers; answers consumed in order, "" after. */
function makeDeps(answers: string[], overrides: Partial<SetupDeps> = {}): Harness {
  const lines: string[] = [];
  const written = new Map<string, { data: string; mode: number }>();
  const commands: string[][] = [];
  const serviceInstalls: string[] = [];
  const queue = [...answers];
  const h: Harness = {
    env: {},
    home: "/home/u",
    stdout: (line) => lines.push(line),
    prompt: async () => queue.shift() ?? "",
    // Default: Ollama up with the default model present.
    fetchImpl: fetchStub(() => tagsResponse(["qwen2.5:latest"])),
    readFile: async () => {
      throw new Error("ENOENT");
    },
    writeFile: async (p, data, mode) => {
      written.set(p, { data, mode });
    },
    mkdir: async () => {},
    runCommand: async (cmd, args) => {
      commands.push([cmd, ...args]);
      return 0;
    },
    randomToken: () => "tok-fixed",
    installService: async (envFile) => {
      serviceInstalls.push(envFile);
    },
    doctor: async () => {
      h.doctorRuns++;
    },
    lines,
    written,
    commands,
    serviceInstalls,
    doctorRuns: 0,
    ...overrides,
  };
  return h;
}

function writtenEnv(h: Harness, path = "/home/u/.tachi/.env"): Record<string, string> {
  const entry = h.written.get(path);
  expect(entry, `expected env file written at ${path}`).toBeDefined();
  expect(entry!.mode).toBe(0o600);
  return parseEnvFile(entry!.data);
}

// ---------------------------------------------------------------------------
// Default (Ollama) path
// ---------------------------------------------------------------------------

describe("runSetup — ollama path", () => {
  it("accepting all defaults wires the full stack", async () => {
    const h = makeDeps([]); // every prompt answered with "" → defaults
    const path = await runSetup(h);

    expect(path).toBe("/home/u/.tachi/.env");
    const env = writtenEnv(h);
    expect(env.TACHI_DRIVER).toBe("ollama");
    expect(env.TACHIBOT_CMD).toBe("tachibot");
    expect(env.DOKORO_CMD).toBe("dokoro");
    expect(env.GATEWAY_TOKEN).toBe("tok-fixed");
    expect(h.doctorRuns).toBe(1);
    // No service install when declined (default N).
    expect(h.serviceInstalls).toEqual([]);
  });

  it("offers to pull a missing model and runs ollama pull on yes", async () => {
    const h = makeDeps(["1", "y"], {
      fetchImpl: fetchStub(() => tagsResponse([])), // ollama up, model absent
    });
    await runSetup(h);
    expect(h.commands).toContainEqual(["ollama", "pull", "qwen2.5"]);
  });

  it("survives Ollama being down (non-fatal, still writes env)", async () => {
    const h = makeDeps([], {
      fetchImpl: fetchStub(() => {
        throw new Error("ECONNREFUSED");
      }),
    });
    await runSetup(h);
    expect(writtenEnv(h).TACHI_DRIVER).toBe("ollama");
    expect(h.lines.join("\n")).toContain("Ollama not reachable");
  });
});

// ---------------------------------------------------------------------------
// OpenRouter path
// ---------------------------------------------------------------------------

describe("runSetup — openrouter path", () => {
  it("valid key sets driver + council gateway in one shot", async () => {
    const h = makeDeps(["2", "sk-or-v1-goodkey"], {
      fetchImpl: fetchStub((url, init) => {
        if (url.includes("openrouter.ai")) {
          const auth = (init?.headers as Record<string, string>)?.Authorization;
          return new Response("{}", { status: auth === "Bearer sk-or-v1-goodkey" ? 200 : 401 });
        }
        return tagsResponse(["qwen2.5:latest"]);
      }),
    });
    await runSetup(h);
    const env = writtenEnv(h);
    expect(env.TACHI_DRIVER).toBe("openrouter");
    expect(env.OPENROUTER_API_KEY).toBe("sk-or-v1-goodkey");
    expect(env.USE_OPENROUTER_GATEWAY).toBe("true");
  });

  it("rejected key, declined save → falls back to ollama", async () => {
    // choice 2 → bad key, "n" (don't save) ×3 attempts, then ollama probe fails silently
    const h = makeDeps(["2", "sk-bad", "n", "", "", "", ""], {
      fetchImpl: fetchStub((url) =>
        url.includes("openrouter.ai") ? new Response("{}", { status: 401 }) : tagsResponse([]),
      ),
    });
    await runSetup(h);
    expect(writtenEnv(h).TACHI_DRIVER).toBe("ollama");
    expect(writtenEnv(h).OPENROUTER_API_KEY).toBeUndefined();
  });

  it("empty key input falls back to ollama driver", async () => {
    const h = makeDeps(["2", ""]);
    await runSetup(h);
    expect(writtenEnv(h).TACHI_DRIVER).toBe("ollama");
  });
});

// ---------------------------------------------------------------------------
// Merge / re-run behaviour
// ---------------------------------------------------------------------------

describe("runSetup — re-run preserves existing values", () => {
  it("keeps unknown keys, GATEWAY_TOKEN and custom CMDs from a prior run", async () => {
    const h = makeDeps([], {
      readFile: async () =>
        "MY_CUSTOM=keepme\nGATEWAY_TOKEN=old-token\nTACHIBOT_CMD=npx -y tachibot-mcp\n",
    });
    await runSetup(h);
    const env = writtenEnv(h);
    expect(env.MY_CUSTOM).toBe("keepme");
    expect(env.GATEWAY_TOKEN).toBe("old-token"); // not regenerated
    expect(env.TACHIBOT_CMD).toBe("npx -y tachibot-mcp"); // not clobbered
  });

  it("service install offer delegates with the env-file path", async () => {
    // brain, extra-keys, telegram, slack → defaults; service question → y
    const h = makeDeps(["", "", "", "", "y"]);
    await runSetup(h);
    expect(h.serviceInstalls).toEqual(["/home/u/.tachi/.env"]);
  });

  it("refreshes file-loaded env values in-process so the doctor run sees the NEW config", async () => {
    // loadUserEnv seeded TACHI_DRIVER=ollama from the OLD file; the wizard
    // switches to openrouter — env must reflect that for the same-process doctor.
    const h = makeDeps(["2", "sk-or-v1-goodkey"], {
      env: { TACHI_DRIVER: "ollama" },
      envFileKeys: ["TACHI_DRIVER"],
      readFile: async () => "TACHI_DRIVER=ollama\n",
      fetchImpl: fetchStub((url) =>
        url.includes("openrouter.ai") ? new Response("{}", { status: 200 }) : tagsResponse(["qwen2.5:latest"]),
      ),
    });
    await runSetup(h);
    expect(h.env.TACHI_DRIVER).toBe("openrouter");
  });

  it("never overrides a REAL shell env var (key not in envFileKeys)", async () => {
    const h = makeDeps([], { env: { TACHI_DRIVER: "openai" } });
    await runSetup(h);
    expect(h.env.TACHI_DRIVER).toBe("openai"); // in-process: the shell wins
    expect(writtenEnv(h).TACHI_DRIVER).toBe("ollama"); // file: the wizard's choice
  });

  it("Enter on an extra council key does NOT copy a shell-env secret into the file", async () => {
    // brain default; extra-keys → y; all five key prompts answered with Enter.
    const h = makeDeps(["", "y"], { env: { OPENAI_API_KEY: "sk-live-supersecret" } });
    await runSetup(h);
    expect(writtenEnv(h).OPENAI_API_KEY).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// serializeEnvFile
// ---------------------------------------------------------------------------

describe("serializeEnvFile", () => {
  it("round-trips through parseEnvFile, quoting values with spaces", () => {
    const input = { B_KEY: "plain", A_CMD: "npx -y tachibot-mcp", C: 'say "hi"' };
    const out = serializeEnvFile(input);
    expect(parseEnvFile(out)).toEqual(input);
    // sorted keys, header comment present
    expect(out.startsWith("#")).toBe(true);
    expect(out.indexOf("A_CMD")).toBeLessThan(out.indexOf("B_KEY"));
  });

  it("collapses newlines in values — no phantom keys injected on re-parse", () => {
    const out = serializeEnvFile({ A: "line1\nEVIL=1", C: "ok" });
    expect(parseEnvFile(out)).toEqual({ A: "line1 EVIL=1", C: "ok" });
  });
});

// ---------------------------------------------------------------------------
// env-bootstrap
// ---------------------------------------------------------------------------

describe("env-bootstrap", () => {
  it("applyEnvDefaults never overrides existing env vars", () => {
    const env: Record<string, string | undefined> = { TACHI_DRIVER: "openrouter" };
    const applied = applyEnvDefaults(env, { TACHI_DRIVER: "ollama", DOKORO_CMD: "dokoro" });
    expect(env.TACHI_DRIVER).toBe("openrouter");
    expect(env.DOKORO_CMD).toBe("dokoro");
    expect(applied).toEqual(["DOKORO_CMD"]);
  });

  it("userEnvPath honours TACHI_ENV_FILE override", () => {
    expect(userEnvPath({}, "/home/u")).toBe("/home/u/.tachi/.env");
    expect(userEnvPath({ TACHI_ENV_FILE: "/etc/tachi.env" }, "/home/u")).toBe("/etc/tachi.env");
  });
});
