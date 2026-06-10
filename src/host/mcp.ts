/**
 * McpToolHost — connects to one or more MCP servers (dokoro, tachibot) over stdio
 * and exposes their tools as a single merged, namespaced registry: `${server}_${tool}`.
 *
 * SECURITY: server commands come ONLY from trusted config (never from a user/agent
 * message), and an optional `allow` list whitelists which tools are exposed — keep
 * write/dangerous tools out unless you mean to grant them.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ToolHost, AgentTool } from "../types.js";

export interface McpServerConfig {
  name: string;          // namespace, e.g. "dokoro" | "tachibot" (no underscores)
  command: string;       // trusted executable, e.g. "npx"
  args?: string[];       // e.g. ["-y", "tachibot-mcp"]
  env?: Record<string, string>;
}

export interface McpToolHostOptions {
  /** Allowlist of namespaced tool names (exact) or `${server}_` prefixes. Empty/undefined = allow all. */
  allow?: string[];
  /** Per-call wall-clock timeout in ms. A hung MCP tool MUST NOT block the run. Default 120_000. */
  callTimeoutMs?: number;
  /**
   * Cap (chars) on a single tool's text result before it is handed to the model.
   * Council/search outputs can be huge and would flood a small local model's
   * context; over-cap results are cut with a `…[truncated N chars]` marker.
   * <= 0 disables truncation. Default DEFAULT_MAX_RESULT_CHARS (overridable via
   * the TACHI_MAX_TOOL_RESULT_CHARS env var; explicit option wins).
   */
  maxResultChars?: number;
}

/** Default per-result cap (~7–8k tokens) — generous for legit council output, safe for a 3–8B local context. */
export const DEFAULT_MAX_RESULT_CHARS = 30_000;

/** Truncate `text` to `maxChars`, appending a marker with the removed length. <= 0 disables. */
export function truncateResult(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n…[truncated ${text.length - maxChars} chars]`;
}

/**
 * Does this error mean the MCP server's child process died / the stdio transport
 * closed? The SDK surfaces this as "Connection closed" (McpError -32000) for
 * in-flight requests and "Not connected" for requests after close — neither
 * names the server, so we rewrite them into an actionable per-call message.
 */
export function isDisconnectError(message: string): boolean {
  return /connection closed|not connected|transport.*closed|EPIPE/i.test(message);
}

/** Resolve the result cap: explicit option > TACHI_MAX_TOOL_RESULT_CHARS env > default. */
function resolveMaxResultChars(opt: number | undefined): number {
  if (opt !== undefined) return opt;
  const raw = process.env.TACHI_MAX_TOOL_RESULT_CHARS;
  if (raw !== undefined && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return DEFAULT_MAX_RESULT_CHARS;
}

/**
 * Headroom (ms) added to the host's authoritative timeout when arming the MCP
 * SDK's own per-request timer. The SDK ALWAYS arms a timer (its hidden default is
 * DEFAULT_REQUEST_TIMEOUT_MSEC = 60_000); passing an explicit value just beyond
 * the host deadline keeps the SDK from independently preempting long calls at 60s,
 * while letting the host's AbortController remain the primary timeout authority.
 */
export const SDK_TIMEOUT_BACKSTOP_MS = 5_000;

export function nsName(server: string, tool: string): string {
  return `${server}_${tool}`;
}

/** Split a namespaced name on the FIRST underscore (server names contain none). */
export function parseNs(namespaced: string): { server: string; tool: string } {
  const i = namespaced.indexOf("_");
  if (i < 0) return { server: namespaced, tool: "" };
  return { server: namespaced.slice(0, i), tool: namespaced.slice(i + 1) };
}

export function isAllowed(name: string, allow?: string[]): boolean {
  if (!allow || allow.length === 0) return true;
  return allow.some((a) => (a.endsWith("_") ? name.startsWith(a) : name === a));
}

export class McpToolHost implements ToolHost {
  private clients = new Map<string, Client>();
  private merged: AgentTool[] = [];

  constructor(private readonly opts: McpToolHostOptions = {}) {}

  async connect(servers: McpServerConfig[]): Promise<void> {
    for (const s of servers) {
      const transport = new StdioClientTransport({
        command: s.command,
        args: s.args ?? [],
        env: s.env,
        // Suppress child-server stderr (heartbeats/startup noise) so it doesn't
        // flood the CLI/REPL. Set TACHI_DEBUG to see it for troubleshooting.
        stderr: process.env.TACHI_DEBUG ? "inherit" : "ignore",
      });
      const client = new Client({ name: "tachi-agent", version: "0.1.0" }, { capabilities: {} });
      await client.connect(transport);
      this.clients.set(s.name, client);

      const { tools } = await client.listTools();
      for (const t of tools) {
        const name = nsName(s.name, t.name);
        if (!isAllowed(name, this.opts.allow)) continue;
        this.merged.push({
          name,
          description: t.description ?? "",
          parameters: (t.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
        });
      }
    }
  }

  tools(): AgentTool[] {
    return this.merged;
  }

  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    if (!isAllowed(name, this.opts.allow)) throw new Error(`Tool "${name}" is not in the allowlist`);
    const { server, tool } = parseNs(name);
    const client = this.clients.get(server);
    if (!client) throw new Error(`No MCP server "${server}" connected`);

    const timeoutMs = this.opts.callTimeoutMs ?? 120_000;

    // PRIMARY timeout authority: our own AbortController. The caller's signal and
    // our timer both abort it; that single abort both cancels the SDK call (forwarded
    // as `signal`, so the server gets a cancellation notification) AND settles our
    // race promise with one deterministic, distinguishable error.
    //
    // The MCP SDK ALWAYS arms its own per-request timer (hidden default
    // DEFAULT_REQUEST_TIMEOUT_MSEC = 60_000). If we passed only `signal`, the SDK
    // would independently fire at 60s — silently capping any callTimeoutMs > 60_000
    // (the default is 120_000) and stealing the race with its own "Request timed
    // out" message. So we pass an explicit `timeout = timeoutMs + backstop`: the
    // SDK timer becomes a BACKSTOP just beyond our authoritative deadline, never the
    // active deadline. In practice our AbortController always wins first, so the
    // deterministic message and the abort-vs-timeout distinction are preserved.
    const timeoutAc = new AbortController();
    const onCallerAbort = () => timeoutAc.abort();
    signal?.addEventListener("abort", onCallerAbort, { once: true });
    const timer = setTimeout(() => timeoutAc.abort(), timeoutMs);

    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutAc.signal.addEventListener("abort", () => {
        // Distinguish caller-abort from our own timeout in the error message.
        reject(signal?.aborted
          ? new Error(`Tool "${name}" aborted`)
          : new Error(`Tool "${name}" timed out after ${timeoutMs}ms`));
      }, { once: true });
    });

    try {
      const res = (await Promise.race([
        client.callTool({ name: tool, arguments: args }, undefined, {
          signal: timeoutAc.signal,
          timeout: timeoutMs + SDK_TIMEOUT_BACKSTOP_MS,
        }),
        timeout,
      ])) as { content?: Array<{ type?: string; text?: string }> };
      const text = (res.content ?? [])
        .filter((p) => p?.type === "text" && typeof p.text === "string")
        .map((p) => p.text)
        .join("\n");
      // Cap the result before it reaches the model's context (council outputs can be huge).
      return truncateResult(text || JSON.stringify(res.content ?? res), resolveMaxResultChars(this.opts.maxResultChars));
    } catch (e) {
      // A dead child process surfaces as a bare "Connection closed"/"Not connected" —
      // rewrite it so the model (and the user) see WHICH server died and what to do.
      const msg = e instanceof Error ? e.message : String(e);
      if (isDisconnectError(msg)) {
        throw new Error(
          `Tool "${name}" failed: MCP server "${server}" disconnected (${msg}). ` +
          `The server child process likely exited; restart the agent to reconnect.`,
        );
      }
      throw e;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onCallerAbort);
    }
  }

  async close(): Promise<void> {
    for (const c of this.clients.values()) {
      try { await c.close(); } catch { /* best effort */ }
    }
  }
}
