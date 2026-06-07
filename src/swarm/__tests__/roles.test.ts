// src/swarm/__tests__/roles.test.ts
import { describe, it, expect } from "vitest";
import { parseRoles, DEFAULT_ROLES } from "../roles.js";

describe("parseRoles", () => {
  it("returns the default roles when env is empty/undefined", () => {
    expect(parseRoles(undefined)).toEqual(DEFAULT_ROLES);
    expect(parseRoles("")).toEqual(DEFAULT_ROLES);
  });
  it("parses 'name' and 'name:driver' tokens, trimming blanks", () => {
    const roles = parseRoles("implementer, critic:hermes , ");
    expect(roles.map((r) => r.name)).toEqual(["implementer", "critic"]);
    expect(roles[1].driver).toBe("hermes");
    expect(roles[0].driver).toBeUndefined();
    expect(roles[0].systemPrompt.length).toBeGreaterThan(0); // known names get a preset prompt
  });
  it("gives an unknown role a generic lens prompt naming the role", () => {
    const [r] = parseRoles("skeptic");
    expect(r.name).toBe("skeptic");
    expect(r.systemPrompt).toMatch(/skeptic/i);
  });
  it("marks the default critic role as critical (for quorum checks)", () => {
    const critic = DEFAULT_ROLES.find((r) => r.name === "critic");
    expect(critic?.critical).toBe(true);
  });
  it("preserves the critical flag for known critical roles when configured explicitly", () => {
    expect(parseRoles("critic")[0].critical).toBe(true);
    expect(parseRoles("implementer")[0].critical).toBeUndefined();
    expect(parseRoles("critic:hermes")[0].critical).toBe(true); // still set with a driver
  });
  it("returns a fresh array on the default path (callers cannot corrupt DEFAULT_ROLES)", () => {
    const a = parseRoles("");
    expect(a).not.toBe(DEFAULT_ROLES); // distinct reference, not the shared constant
    a.push({ name: "rogue", systemPrompt: "x" });
    expect(DEFAULT_ROLES.some((r) => r.name === "rogue")).toBe(false);
    expect(parseRoles(undefined)).toHaveLength(DEFAULT_ROLES.length); // still intact
  });
});
