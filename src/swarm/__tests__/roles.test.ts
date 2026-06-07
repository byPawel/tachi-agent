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
});
