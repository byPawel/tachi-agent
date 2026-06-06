import { describe, it, expect } from "vitest";
import { parseAllowedSlackIds, isSlackAuthorized } from "../slack.js";

describe("parseAllowedSlackIds", () => {
  it("parses a comma-separated list of string ids", () => {
    expect(parseAllowedSlackIds("U1, U2,U3")).toEqual(new Set(["U1", "U2", "U3"]));
  });
  it("returns an empty Set for an empty string", () => {
    expect(parseAllowedSlackIds("")).toEqual(new Set());
  });
  it("returns an empty Set for undefined", () => {
    expect(parseAllowedSlackIds(undefined)).toEqual(new Set());
  });
  it("trims whitespace and drops empty tokens", () => {
    expect(parseAllowedSlackIds(" U1 , ,U2 ")).toEqual(new Set(["U1", "U2"]));
  });
});

describe("isSlackAuthorized", () => {
  it("returns true when the id is in the allowlist", () => {
    expect(isSlackAuthorized("U1", new Set(["U1", "U2"]))).toBe(true);
  });
  it("returns false when the id is not in the allowlist", () => {
    expect(isSlackAuthorized("U9", new Set(["U1"]))).toBe(false);
  });
  it("fails closed — empty allowlist denies every id", () => {
    expect(isSlackAuthorized("U1", new Set())).toBe(false);
  });
  it("returns false for undefined userId", () => {
    expect(isSlackAuthorized(undefined, new Set(["U1"]))).toBe(false);
  });
});
