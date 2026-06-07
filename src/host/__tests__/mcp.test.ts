import { describe, it, expect } from "vitest";
import { nsName, parseNs, isAllowed, McpToolHost } from "../mcp.js";

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
function hostWith(server: string, client: unknown, callTimeoutMs?: number): McpToolHost {
  const host = new McpToolHost({ callTimeoutMs });
  (host as unknown as { clients: Map<string, unknown> }).clients.set(server, client);
  return host;
}

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
