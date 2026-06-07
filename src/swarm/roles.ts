// src/swarm/roles.ts
import type { SwarmRole } from "./types.js";

export const DEFAULT_ROLES: SwarmRole[] = [
  { name: "implementer", systemPrompt: "You are the IMPLEMENTER. Give the most direct, correct, buildable answer. Prefer concrete steps over discussion." },
  { name: "critic", systemPrompt: "You are the CRITIC. Find the flaws, risks, and edge cases in the obvious answer. Argue what would go wrong and why.", critical: true },
  { name: "researcher", systemPrompt: "You are the RESEARCHER. Ground the answer in current facts and prior art; cite what you searched and surface anything the others would miss." },
];

const PRESET = new Map(DEFAULT_ROLES.map((r) => [r.name, r.systemPrompt]));

/** Parse a comma-separated roles spec ("name" or "name:driver"); empty → DEFAULT_ROLES. */
export function parseRoles(env: string | undefined): SwarmRole[] {
  if (!env || env.trim() === "") return DEFAULT_ROLES;
  const roles: SwarmRole[] = [];
  for (const tok of env.split(",")) {
    const t = tok.trim();
    if (t === "") continue;
    const [name, driver] = t.split(":").map((s) => s.trim());
    if (!name) continue;
    const systemPrompt = PRESET.get(name) ?? `You are the ${name.toUpperCase()}. Answer the task through the distinct lens of a "${name}".`;
    roles.push({ name, systemPrompt, ...(driver ? { driver } : {}) });
  }
  return roles.length > 0 ? roles : DEFAULT_ROLES;
}
