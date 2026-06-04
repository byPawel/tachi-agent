/**
 * Driver registry — "brains are config, not code".
 *
 * External packages (an OpenClaw driver, a cloud-model driver, a Kimi-swarm
 * driver) register a named Driver factory; front-ends then select one by name.
 * This is the extensibility seam WITHOUT a plugin framework: just a name→factory
 * map. The same pattern can be mirrored for ToolHosts/Memory if a 2nd consumer
 * ever needs it (YAGNI until then).
 */
import type { Driver } from "./types.js";

const drivers = new Map<string, () => Driver>();

/** Register a Driver factory under a name (idempotent — last registration wins). */
export function registerDriver(name: string, factory: () => Driver): void {
  drivers.set(name, factory);
}

/** Resolve a registered Driver by name. Throws a helpful error if unknown. */
export function getDriver(name: string): Driver {
  const factory = drivers.get(name);
  if (!factory) {
    const known = [...drivers.keys()].join(", ") || "(none registered)";
    throw new Error(`Unknown driver "${name}". Registered: ${known}`);
  }
  return factory();
}

/** Names of all registered drivers. */
export function listDrivers(): string[] {
  return [...drivers.keys()];
}
