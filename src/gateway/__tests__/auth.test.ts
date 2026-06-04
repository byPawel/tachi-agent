// src/gateway/__tests__/auth.test.ts
import { describe, it, expect } from "vitest";
import { parseBearer, resolveTenant } from "../auth.js";

describe("parseBearer", () => {
  it("extracts the token from an Authorization header", () => {
    expect(parseBearer("Bearer abc123")).toBe("abc123");
    expect(parseBearer("bearer abc123")).toBe("abc123");
  });
  it("returns null when missing or malformed", () => {
    expect(parseBearer(undefined)).toBeNull();
    expect(parseBearer("Basic xyz")).toBeNull();
  });
});

describe("resolveTenant", () => {
  it("maps a token to a tenant in multi-tenant mode", () => {
    const env = { GATEWAY_TOKENS: "alice:tokA, bob:tokB" };
    expect(resolveTenant("tokA", env)).toEqual({ tenant: "alice" });
    expect(resolveTenant("tokB", env)).toEqual({ tenant: "bob" });
    expect(resolveTenant("nope", env)).toBeNull();
  });
  it("uses 'default' tenant in single-token mode", () => {
    expect(resolveTenant("s3cret", { GATEWAY_TOKEN: "s3cret" })).toEqual({ tenant: "default" });
    expect(resolveTenant("wrong", { GATEWAY_TOKEN: "s3cret" })).toBeNull();
  });
  it("rejects when no token is configured or token is null", () => {
    expect(resolveTenant("x", {})).toBeNull();
    expect(resolveTenant(null, { GATEWAY_TOKEN: "s3cret" })).toBeNull();
  });
});
