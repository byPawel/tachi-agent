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
}

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
      const transport = new StdioClientTransport({ command: s.command, args: s.args ?? [], env: s.env });
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

  async call(name: string, args: Record<string, unknown>): Promise<string> {
    if (!isAllowed(name, this.opts.allow)) throw new Error(`Tool "${name}" is not in the allowlist`);
    const { server, tool } = parseNs(name);
    const client = this.clients.get(server);
    if (!client) throw new Error(`No MCP server "${server}" connected`);
    const res = (await client.callTool({ name: tool, arguments: args })) as { content?: Array<{ type?: string; text?: string }> };
    const text = (res.content ?? [])
      .filter((p) => p?.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n");
    return text || JSON.stringify(res.content ?? res);
  }

  async close(): Promise<void> {
    for (const c of this.clients.values()) {
      try { await c.close(); } catch { /* best effort */ }
    }
  }
}
