import { describe, it, expect, vi, afterEach } from "vitest";
import { nsName, parseNs, isAllowed, McpToolHost, truncateResult, DEFAULT_MAX_RESULT_CHARS } from "../mcp.js";

describe("nsName", () => {
  it("joins server and tool with an underscore", () => {
    expect(nsName("tachibot", "jury")).toBe("tachibot_jury");
  });
});

describe("parseNs", () => {
  it("splits on the first underscore for a multi-underscore tool name", () => {
    expect(parseNs("dokoro_session_recall")).toEqual({ server: "dokoro", tool: "session_recall" });
  });

  it("splits on the first underscore for a single-underscore name", () => {
    expect(parseNs("tachibot_jury")).toEqual({ server: "tachibot", tool: "jury" });
  });
});

describe("isAllowed", () => {
  it("returns true when allow is undefined", () => {
    expect(isAllowed("tachibot_jury")).toBe(true);
  });

  it("returns true when allow is an empty array", () => {
    expect(isAllowed("tachibot_jury", [])).toBe(true);
  });

  it("returns true for an exact match in the allow list", () => {
    expect(isAllowed("dokoro_session_recall", ["dokoro_session_recall"])).toBe(true);
  });

  it("returns false when the allow list has entries but none match", () => {
    expect(isAllowed("tachibot_jury", ["dokoro_session_recall"])).toBe(false);
  });

  it("returns true for a prefix match via trailing underscore entry", () => {
    expect(isAllowed("tachibot_jury", ["tachibot_"])).toBe(true);
  });
});

describe("truncateResult", () => {
  it("returns short text unchanged", () => {
    expect(truncateResult("hello", 100)).toBe("hello");
  });

  it("returns text exactly at the cap unchanged", () => {
    expect(truncateResult("abcde", 5)).toBe("abcde");
  });

  it("truncates over-cap text and appends a marker counting the removed chars", () => {
    const out = truncateResult("a".repeat(120), 100);
    expect(out.startsWith("a".repeat(100))).toBe(true);
    expect(out).toContain("…[truncated 20 chars]");
  });

  it("disables truncation when maxChars <= 0", () => {
    const big = "x".repeat(1000);
    expect(truncateResult(big, 0)).toBe(big);
    expect(truncateResult(big, -1)).toBe(big);
  });

  it("has a sane positive default cap", () => {
    expect(DEFAULT_MAX_RESULT_CHARS).toBeGreaterThan(1000);
  });
});

/** A fake MCP Client that resolves with the given text. */
function textClient(text: string) {
  return {
    callTool: async () => ({ content: [{ type: "text", text }] }),
    close: async () => {},
  };
}

describe("McpToolHost.call result truncation", () => {
  it("truncates a huge tool result to maxResultChars with a marker (council outputs must not flood the local context)", async () => {
    const host = hostWith("tachibot", textClient("z".repeat(500)), undefined, { maxResultChars: 100 });
    const out = await host.call("tachibot_jury", { q: "x" });
    expect(out.length).toBeLessThan(200);
    expect(out.startsWith("z".repeat(100))).toBe(true);
    expect(out).toContain("…[truncated 400 chars]");
  });

  it("passes results under the cap through unchanged", async () => {
    const host = hostWith("tachibot", textClient("short answer"), undefined, { maxResultChars: 100 });
    await expect(host.call("tachibot_jury", {})).resolves.toBe("short answer");
  });

  it("maxResultChars <= 0 disables truncation", async () => {
    const host = hostWith("tachibot", textClient("z".repeat(500)), undefined, { maxResultChars: 0 });
    const out = await host.call("tachibot_jury", {});
    expect(out).toBe("z".repeat(500));
  });

  it("applies the default cap when maxResultChars is unset", async () => {
    const host = hostWith("tachibot", textClient("z".repeat(DEFAULT_MAX_RESULT_CHARS + 50)));
    const out = await host.call("tachibot_jury", {});
    expect(out).toContain("…[truncated 50 chars]");
    expect(out.length).toBeLessThan(DEFAULT_MAX_RESULT_CHARS + 50);
  });
});

describe("McpToolHost.call result cap — TACHI_MAX_TOOL_RESULT_CHARS env precedence", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("env alone sets the cap when no explicit option is given", async () => {
    vi.stubEnv("TACHI_MAX_TOOL_RESULT_CHARS", "100");
    const host = hostWith("tachibot", textClient("z".repeat(500)));
    const out = await host.call("tachibot_jury", {});
    expect(out.startsWith("z".repeat(100))).toBe(true);
    expect(out).toContain("…[truncated 400 chars]");
  });

  it("an explicit maxResultChars option wins over the env var", async () => {
    vi.stubEnv("TACHI_MAX_TOOL_RESULT_CHARS", "100");
    const host = hostWith("tachibot", textClient("z".repeat(500)), undefined, { maxResultChars: 200 });
    const out = await host.call("tachibot_jury", {});
    expect(out.startsWith("z".repeat(200))).toBe(true);
    expect(out).toContain("…[truncated 300 chars]");
  });

  it("explicit option 0 (disable) wins over an env cap", async () => {
    vi.stubEnv("TACHI_MAX_TOOL_RESULT_CHARS", "100");
    const host = hostWith("tachibot", textClient("z".repeat(500)), undefined, { maxResultChars: 0 });
    await expect(host.call("tachibot_jury", {})).resolves.toBe("z".repeat(500));
  });

  it("a non-numeric env value falls back to the default cap", async () => {
    vi.stubEnv("TACHI_MAX_TOOL_RESULT_CHARS", "not-a-number");
    const host = hostWith("tachibot", textClient("z".repeat(DEFAULT_MAX_RESULT_CHARS + 50)));
    const out = await host.call("tachibot_jury", {});
    expect(out).toContain("…[truncated 50 chars]"); // default cap applied, not Infinity/NaN
  });

  it("a blank env value falls back to the default cap", async () => {
    vi.stubEnv("TACHI_MAX_TOOL_RESULT_CHARS", "   ");
    const host = hostWith("tachibot", textClient("z".repeat(DEFAULT_MAX_RESULT_CHARS + 50)));
    const out = await host.call("tachibot_jury", {});
    expect(out).toContain("…[truncated 50 chars]");
  });
});

/** A fake MCP Client whose callTool hangs until aborted (honours options.signal). */
function hangingClient() {
  return {
    callTool: (_params: unknown, _schema: unknown, options?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted by signal")),
        );
        // otherwise: never resolves
      }),
    close: async () => {},
  };
}

/** Reach into the private clients map to inject a fake without a live transport. */
function hostWith(
  server: string,
  client: unknown,
  callTimeoutMs?: number,
  extra?: { maxResultChars?: number },
): McpToolHost {
  const host = new McpToolHost({ callTimeoutMs, ...extra });
  (host as unknown as { clients: Map<string, unknown> }).clients.set(server, client);
  return host;
}

describe("McpToolHost.call when the MCP server child process has died", () => {
  /** The SDK rejects in-flight requests with "Connection closed" (McpError -32000)
   *  and new requests on a closed transport with "Not connected". */
  function deadClient(message: string) {
    return {
      callTool: () => Promise.reject(new Error(message)),
      close: async () => {},
    };
  }

  it("rewrites 'Connection closed' into an actionable error naming the tool and server", async () => {
    const host = hostWith("tachibot", deadClient("MCP error -32000: Connection closed"));
    await expect(host.call("tachibot_jury", { q: "x" })).rejects.toThrow(
      /tool "tachibot_jury".*server "tachibot" disconnected/i,
    );
  });

  it("rewrites 'Not connected' the same way and preserves the original message", async () => {
    const host = hostWith("dokoro", deadClient("Not connected"));
    const err = await host.call("dokoro_dokoro_session_recall", {}).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/server "dokoro" disconnected/i);
    expect((err as Error).message).toContain("Not connected");
  });

  it("passes unrelated tool errors through untouched", async () => {
    const host = hostWith("tachibot", deadClient("invalid arguments: query is required"));
    await expect(host.call("tachibot_jury", {})).rejects.toThrow(
      /^invalid arguments: query is required$/,
    );
  });

  it("does not rewrite its own timeout error", async () => {
    const host = hostWith("tachibot", hangingClient(), 20);
    await expect(host.call("tachibot_jury", {})).rejects.toThrow(/timed out after 20ms/i);
  });
});

describe("McpToolHost.call timeout", () => {
  it("rejects when a tool call hangs past the timeout", async () => {
    const host = hostWith("tachibot", hangingClient(), 30);
    await expect(host.call("tachibot_jury", { q: "x" })).rejects.toThrow(/timed out/i);
  });

  it("forwards the caller's signal to the SDK call and aborts the in-flight call", async () => {
    // GENUINE proof of forwarding: capture the options the host hands to callTool.
    // (Asserting on the rejection message alone is NOT enough — the host's own
    // timeout-race promise rejects with `Tool "…" aborted` the moment the caller
    // aborts and wins the race, so that message would match even if the signal were
    // never forwarded. The spy below fails unless callTool actually received it.)
    let forwardedSignal: AbortSignal | undefined;
    let signalAtAbort = false;
    const client = {
      callTool: (_params: unknown, _schema: unknown, options?: { signal?: AbortSignal }) => {
        forwardedSignal = options?.signal;
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            signalAtAbort = true; // the forwarded signal actually fired inside callTool
            reject(new Error("aborted by signal"));
          });
        });
      },
      close: async () => {},
    };
    // Long host timeout so the only thing that can abort the call is the caller signal.
    const host = hostWith("tachibot", client, 10_000);
    const ac = new AbortController();
    const p = host.call("tachibot_jury", { q: "x" }, ac.signal);
    ac.abort();
    await expect(p).rejects.toThrow(/abort/i);
    // The signal reached callTool AND fired through to the SDK call — not dead code.
    expect(forwardedSignal).toBeInstanceOf(AbortSignal);
    expect(signalAtAbort).toBe(true);
  });

  it("uses the configured callTimeoutMs (short timeout fires fast)", async () => {
    const host = hostWith("tachibot", hangingClient(), 20);
    const start = Date.now();
    await expect(host.call("tachibot_jury", {})).rejects.toThrow(/timed out/i);
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("passes an explicit SDK timeout >= the configured callTimeoutMs (no hidden 60s cap)", async () => {
    // The MCP SDK ALWAYS arms its own per-request timer (DEFAULT_REQUEST_TIMEOUT_MSEC
    // = 60_000). If the host forwards only `signal` and no `timeout`, the SDK would
    // independently preempt any long call at 60s — silently capping callTimeoutMs.
    // The host must pass an explicit `timeout` so the SDK's timer is a backstop just
    // beyond the host's authoritative deadline, never below it.
    let forwardedTimeout: unknown;
    const client = {
      callTool: (_params: unknown, _schema: unknown, options?: { timeout?: number }) => {
        forwardedTimeout = options?.timeout;
        // Resolve immediately so the host returns normally; we only inspect options.
        return Promise.resolve({ content: [{ type: "text", text: "ok" }] });
      },
      close: async () => {},
    };
    const host = hostWith("tachibot", client, 90_000);
    await host.call("tachibot_jury", { q: "x" });
    expect(typeof forwardedTimeout).toBe("number");
    expect(forwardedTimeout as number).toBeGreaterThanOrEqual(90_000);
  });
});
