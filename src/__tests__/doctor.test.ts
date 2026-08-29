/**
 * Tests for doctor.ts — preflight diagnostics.
 * TDD: written before the implementation. All IO stubbed via DoctorDeps.
 */
import { describe, it, expect, afterEach, vi } from "vitest";

import { runDoctor, checkCodingAgents, type DoctorDeps, type CheckResult } from "../doctor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** fetch stub that routes by URL substring; default 200 {} JSON. */
function fetchStub(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) =>
    handler(String(url), init)) as typeof fetch;
}

/** An Ollama /api/tags response listing the given model names. */
function tagsResponse(modelNames: string[]): Response {
  return new Response(
    JSON.stringify({ models: modelNames.map((name) => ({ name })) }),
    { status: 200 },
  );
}

function makeDeps(overrides: Partial<DoctorDeps> = {}): DoctorDeps & { lines: string[] } {
  const lines: string[] = [];
  return {
    env: {},
    // Default: Ollama reachable with the default model present, no daemon.
    fetchImpl: fetchStub(() => tagsResponse(["qwen2.5:latest"])),
    stdout: (line: string) => lines.push(line),
    nodeVersion: "v22.1.0",
    loadSkills: async () => [],
    lines,
    ...overrides,
  };
}

function find(results: CheckResult[], name: string): CheckResult {
  const r = results.find((c) => c.name === name);
  if (!r) throw new Error(`no check named ${name} in ${results.map((c) => c.name).join(", ")}`);
  return r;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// node
// ---------------------------------------------------------------------------
describe("doctor: node check", () => {
  it("passes on Node >= 20 with the version as detail", async () => {
    const deps = makeDeps({ nodeVersion: "v22.1.0" });
    const { results } = await runDoctor(deps);
    const r = find(results, "node");
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("v22.1.0");
  });

  it("fails critically on Node < 20", async () => {
    const deps = makeDeps({ nodeVersion: "v18.19.0" });
    const { results, ok } = await runDoctor(deps);
    const r = find(results, "node");
    expect(r.ok).toBe(false);
    expect(r.critical).toBe(true);
    expect(r.detail).toContain("v18.19.0");
    expect(r.detail).toMatch(/20/);
    expect(ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ollama
// ---------------------------------------------------------------------------
describe("doctor: ollama check", () => {
  it("passes when reachable and the default model is present (prefix match)", async () => {
    let hitUrl = "";
    const deps = makeDeps({
      fetchImpl: fetchStub((url) => {
        hitUrl = url;
        return tagsResponse(["qwen2.5:7b-instruct", "llama3:8b"]);
      }),
    });
    const { results } = await runDoctor(deps);
    const r = find(results, "ollama");
    expect(r.ok).toBe(true);
    expect(hitUrl).toBe("http://127.0.0.1:11434/api/tags");
  });

  it("respects OLLAMA_BASE_URL and OLLAMA_MODEL", async () => {
    let hitUrl = "";
    const deps = makeDeps({
      env: { OLLAMA_BASE_URL: "http://gpu-box:11434", OLLAMA_MODEL: "llama3:8b" },
      fetchImpl: fetchStub((url) => {
        if (url.includes("/api/tags")) hitUrl = url;
        return tagsResponse(["llama3:latest"]);
      }),
    });
    const { results } = await runDoctor(deps);
    expect(hitUrl).toBe("http://gpu-box:11434/api/tags");
    expect(find(results, "ollama").ok).toBe(true); // llama3:8b prefix-matches llama3:latest
  });

  it("fails non-critically with a pull hint when the model is missing", async () => {
    const deps = makeDeps({
      fetchImpl: fetchStub(() => tagsResponse(["llama3:8b"])),
    });
    const { results, ok } = await runDoctor(deps);
    const r = find(results, "ollama");
    expect(r.ok).toBe(false);
    expect(r.critical).toBe(false);
    expect(r.detail).toContain("ollama pull qwen2.5");
    expect(ok).toBe(true); // non-critical → doctor still ok
  });

  it("fails critically with a serve hint when unreachable", async () => {
    const deps = makeDeps({
      fetchImpl: fetchStub(() => {
        throw new Error("ECONNREFUSED");
      }),
    });
    const { results, ok } = await runDoctor(deps);
    const r = find(results, "ollama");
    expect(r.ok).toBe(false);
    expect(r.critical).toBe(true);
    expect(r.detail).toContain("http://127.0.0.1:11434");
    expect(r.detail).toContain("ollama serve");
    expect(ok).toBe(false);
  });

  it("is skipped (ok:null) for a cloud TACHI_DRIVER and does not fetch", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test"); // so the driver check passes
    let fetched = 0;
    const deps = makeDeps({
      env: { TACHI_DRIVER: "openai" },
      fetchImpl: fetchStub(() => {
        fetched++;
        return tagsResponse([]);
      }),
    });
    const { results } = await runDoctor(deps);
    const r = find(results, "ollama");
    expect(r.ok).toBeNull();
    expect(r.detail).toContain("skipped (TACHI_DRIVER=openai)");
    expect(fetched).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// driver
// ---------------------------------------------------------------------------
describe("doctor: driver check", () => {
  it("resolves the default ollama driver", async () => {
    const deps = makeDeps();
    const { results } = await runDoctor(deps);
    const r = find(results, "driver");
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("ollama");
  });

  it("fails critically on an unknown driver, listing registered names", async () => {
    const deps = makeDeps({ env: { TACHI_DRIVER: "frobnicator" } });
    const { results, ok } = await runDoctor(deps);
    const r = find(results, "driver");
    expect(r.ok).toBe(false);
    expect(r.critical).toBe(true);
    expect(r.detail).toContain("frobnicator");
    expect(r.detail).toContain("ollama"); // registered names listed
    expect(ok).toBe(false);
  });

  it("fails critically with the factory's actionable message for a cloud driver without its key", async () => {
    vi.stubEnv("OPENAI_API_KEY", ""); // blank = unset for the factory
    const deps = makeDeps({ env: { TACHI_DRIVER: "openai" } });
    const { results, ok } = await runDoctor(deps);
    const r = find(results, "driver");
    expect(r.ok).toBe(false);
    expect(r.critical).toBe(true);
    expect(r.detail).toContain("OPENAI_API_KEY");
    expect(ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// tachibot / dokoro
// ---------------------------------------------------------------------------
describe("doctor: tachibot/dokoro checks", () => {
  it("reports configured commands", async () => {
    const deps = makeDeps({
      env: { TACHIBOT_CMD: "npx tachibot-mcp", DOKORO_CMD: "npx dokoro" },
    });
    const { results } = await runDoctor(deps);
    expect(find(results, "tachibot")).toMatchObject({
      ok: true,
      detail: "configured: npx tachibot-mcp",
    });
    expect(find(results, "dokoro")).toMatchObject({
      ok: true,
      detail: "configured: npx dokoro",
    });
  });

  it("fails non-critically when unset, with actionable hints", async () => {
    const deps = makeDeps({ env: {} });
    const { results, ok } = await runDoctor(deps);
    const tachibot = find(results, "tachibot");
    expect(tachibot.ok).toBe(false);
    expect(tachibot.critical).toBe(false);
    expect(tachibot.detail).toContain("council tools unavailable");
    expect(tachibot.detail).toContain("TACHIBOT_CMD");
    const dokoro = find(results, "dokoro");
    expect(dokoro.ok).toBe(false);
    expect(dokoro.critical).toBe(false);
    expect(dokoro.detail).toContain("memory disabled");
    expect(dokoro.detail).toContain("DOKORO_CMD");
    expect(ok).toBe(true); // non-critical only
  });
});

// ---------------------------------------------------------------------------
// skills
// ---------------------------------------------------------------------------
describe("doctor: skills check", () => {
  it("lists skill count and names when present", async () => {
    const deps = makeDeps({
      loadSkills: async () => [{ name: "researcher" }, { name: "coder" }],
    });
    const { results } = await runDoctor(deps);
    const r = find(results, "skills");
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("2 skill(s)");
    expect(r.detail).toContain("researcher");
    expect(r.detail).toContain("coder");
  });

  it("is informational (ok:null) when none found", async () => {
    const deps = makeDeps({ loadSkills: async () => [] });
    const { results } = await runDoctor(deps);
    const r = find(results, "skills");
    expect(r.ok).toBeNull();
    expect(r.detail).toContain("none found");
    expect(r.detail).toContain(".tachi/skills");
  });
});

// ---------------------------------------------------------------------------
// daemon
// ---------------------------------------------------------------------------
describe("doctor: daemon check", () => {
  it("is informational local mode when TACHI_DAEMON_URL is unset", async () => {
    const deps = makeDeps({ env: {} });
    const { results } = await runDoctor(deps);
    const r = find(results, "daemon");
    expect(r.ok).toBeNull();
    expect(r.detail).toContain("local mode (no TACHI_DAEMON_URL)");
  });

  it("passes on 200 with the task count, sending the bearer token", async () => {
    let auth: string | null = null;
    const deps = makeDeps({
      env: { TACHI_DAEMON_URL: "http://localhost:4000", GATEWAY_TOKEN: "tok-1" },
      fetchImpl: fetchStub((url, init) => {
        if (url === "http://localhost:4000/tasks") {
          auth = new Headers(init?.headers as Record<string, string>).get("Authorization");
          return new Response(JSON.stringify({ tasks: [{}, {}] }), { status: 200 });
        }
        return tagsResponse(["qwen2.5"]);
      }),
    });
    const { results } = await runDoctor(deps);
    const r = find(results, "daemon");
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("reachable, 2 task(s)");
    expect(auth).toBe("Bearer tok-1");
  });

  it("fails critically on 401 (token rejected)", async () => {
    const deps = makeDeps({
      env: { TACHI_DAEMON_URL: "http://localhost:4000", GATEWAY_TOKEN: "bad" },
      fetchImpl: fetchStub((url) =>
        url.includes("/tasks") ? new Response("unauthorized", { status: 401 }) : tagsResponse(["qwen2.5"]),
      ),
    });
    const { results, ok } = await runDoctor(deps);
    const r = find(results, "daemon");
    expect(r.ok).toBe(false);
    expect(r.critical).toBe(true);
    expect(r.detail).toContain("token rejected");
    expect(ok).toBe(false);
  });

  it("fails critically when unreachable", async () => {
    const deps = makeDeps({
      env: { TACHI_DAEMON_URL: "http://localhost:4000", GATEWAY_TOKEN: "tok" },
      fetchImpl: fetchStub((url) => {
        if (url.includes("localhost:4000")) throw new Error("ECONNREFUSED");
        return tagsResponse(["qwen2.5"]);
      }),
    });
    const { results, ok } = await runDoctor(deps);
    const r = find(results, "daemon");
    expect(r.ok).toBe(false);
    expect(r.critical).toBe(true);
    expect(r.detail).toContain("http://localhost:4000");
    expect(ok).toBe(false);
  });

  it("fails critically when TACHI_DAEMON_URL is set but GATEWAY_TOKEN is missing", async () => {
    const deps = makeDeps({
      env: { TACHI_DAEMON_URL: "http://localhost:4000" },
    });
    const { results, ok } = await runDoctor(deps);
    const r = find(results, "daemon");
    expect(r.ok).toBe(false);
    expect(r.critical).toBe(true);
    expect(r.detail).toContain("GATEWAY_TOKEN");
    expect(ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// coding agents
// ---------------------------------------------------------------------------
describe("doctor: coding agent checks", () => {
  it("reports codex OK when key present and binary resolvable", async () => {
    const results = await checkCodingAgents(
      makeDeps({ env: { CODEX_API_KEY: "sk", TACHI_CODING_AGENTS: "codex" } }),
    );
    const codex = results.find((r) => r.name.includes("codex"));
    expect(codex?.ok).toBe(true);
  });

  it("reports codex broken when configured but no cred", async () => {
    const results = await checkCodingAgents(
      makeDeps({ env: { TACHI_CODING_AGENTS: "codex" } }),
    );
    const codex = results.find((r) => r.name.includes("codex"));
    expect(codex?.ok).toBe(false);
    expect(codex?.critical).toBe(false); // informational, never blocks the CLI
  });

  it("probes claude and reports the missing credential actionably", async () => {
    const results = await checkCodingAgents(
      makeDeps({ env: { TACHI_CODING_AGENTS: "claude" } }),
    );
    const claude = results.find((r) => r.name === "coding:claude");
    expect(claude).toBeDefined();
    expect(claude?.ok).toBe(false); // no ANTHROPIC_API_KEY and no HOME in deps env
    expect(claude?.detail).toMatch(/not found on PATH|ANTHROPIC_API_KEY/);
    expect(claude?.critical).toBe(false);
  });

  it("probes gemini and reports the missing binary or credential actionably", async () => {
    const results = await checkCodingAgents(
      makeDeps({ env: { TACHI_CODING_AGENTS: "gemini" } }),
    );
    const gemini = results.find((r) => r.name === "coding:gemini");
    expect(gemini).toBeDefined();
    expect(gemini?.ok).toBe(false); // not installed on this machine
    expect(gemini?.detail).toMatch(/not found on PATH|GEMINI_API_KEY/);
    expect(gemini?.critical).toBe(false);
  });

  it("names the openrouter row after the default hermes harness and probes HERMES_CLI", async () => {
    const results = await checkCodingAgents(makeDeps({
      env: {
        TACHI_CODING_AGENTS: "openrouter",
        OPENROUTER_API_KEY: "or",
        HERMES_CLI: process.execPath,
        CODEX_CLI: "/definitely/not/on/path/codex",
      },
    }));
    const row = results.find((r) => r.name.startsWith("coding:openrouter"));
    expect(row?.name).toBe("coding:openrouter/hermes");
    expect(row?.ok).toBe(true);
    expect(row?.detail).toContain(process.execPath);
  });

  it("probes CODEX_CLI when TACHI_OPENROUTER_HARNESS selects codex", async () => {
    const results = await checkCodingAgents(makeDeps({
      env: {
        TACHI_CODING_AGENTS: "openrouter",
        TACHI_OPENROUTER_HARNESS: "codex",
        OPENROUTER_API_KEY: "or",
        CODEX_CLI: process.execPath,
        HERMES_CLI: "/definitely/not/on/path/hermes",
      },
    }));
    const row = results.find((r) => r.name.startsWith("coding:openrouter"));
    expect(row?.name).toBe("coding:openrouter/codex");
    expect(row?.ok).toBe(true);
    expect(row?.detail).toContain(process.execPath);
  });

  it("reports an unrecognized harness selector as a non-critical failure", async () => {
    const results = await checkCodingAgents(makeDeps({
      env: { TACHI_CODING_AGENTS: "openrouter", TACHI_OPENROUTER_HARNESS: "bogus", OPENROUTER_API_KEY: "or" },
    }));
    const row = results.find((r) => r.name.startsWith("coding:openrouter"));
    expect(row?.ok).toBe(false);
    expect(row?.critical).toBe(false);
    expect(row?.detail).toMatch(/TACHI_OPENROUTER_HARNESS/);
  });
});

// ---------------------------------------------------------------------------
// output format + footer + exit semantics
// ---------------------------------------------------------------------------
describe("doctor: output and footer", () => {
  it("prints one aligned ✓/✖/– line per check plus a footer", async () => {
    const deps = makeDeps({
      env: { TACHIBOT_CMD: "npx tachibot-mcp", DOKORO_CMD: "npx dokoro" },
      loadSkills: async () => [{ name: "researcher" }],
    });
    const { results, ok } = await runDoctor(deps);
    // one line per check + footer
    expect(deps.lines).toHaveLength(results.length + 1);
    // Column width = longest row name + 2; "coding:openrouter/hermes" (24) is it.
    expect(deps.lines[0]).toBe("✓ node                      v22.1.0");
    const daemonLine = deps.lines.find((l) => l.includes("daemon"));
    expect(daemonLine).toBe("– daemon                    local mode (no TACHI_DAEMON_URL)");
    expect(deps.lines.at(-1)).toBe("doctor: all good");
    expect(ok).toBe(true);
  });

  it("counts every failed check in the footer but only criticals flip ok", async () => {
    // tachibot + dokoro unset → 2 non-critical problems; everything else passes.
    const deps = makeDeps({ env: {} });
    const { ok } = await runDoctor(deps);
    expect(deps.lines.at(-1)).toBe("doctor: 2 problem(s) found");
    expect(ok).toBe(true);
  });

  it("returns ok=false when any critical check fails", async () => {
    const deps = makeDeps({ nodeVersion: "v16.0.0", env: {} });
    const { ok } = await runDoctor(deps);
    expect(ok).toBe(false);
    expect(deps.lines.at(-1)).toMatch(/^doctor: \d+ problem\(s\) found$/);
  });
});
