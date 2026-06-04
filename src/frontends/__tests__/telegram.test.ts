import { describe, it, expect } from "vitest";
import { parseAllowedIds, isAuthorized, extractMessage } from "../telegram.js";

// ─── parseAllowedIds ────────────────────────────────────────────────────────

describe("parseAllowedIds", () => {
  it("parses a comma-separated list of ids", () => {
    expect(parseAllowedIds("1, 2,3")).toEqual(new Set([1, 2, 3]));
  });

  it("returns an empty Set for an empty string", () => {
    expect(parseAllowedIds("")).toEqual(new Set());
  });

  it("returns an empty Set for undefined", () => {
    expect(parseAllowedIds(undefined)).toEqual(new Set());
  });

  it("ignores non-numeric tokens", () => {
    expect(parseAllowedIds("1,abc,2")).toEqual(new Set([1, 2]));
  });
});

// ─── isAuthorized ───────────────────────────────────────────────────────────

describe("isAuthorized", () => {
  it("returns true when the id is in the allowlist", () => {
    expect(isAuthorized(1, new Set([1, 2]))).toBe(true);
  });

  it("returns false when the id is not in the allowlist", () => {
    expect(isAuthorized(2, new Set([1]))).toBe(false);
  });

  it("fails closed — empty allowlist denies every id", () => {
    expect(isAuthorized(1, new Set())).toBe(false);
  });

  it("returns false for undefined userId", () => {
    expect(isAuthorized(undefined, new Set([1]))).toBe(false);
  });
});

// ─── extractMessage ─────────────────────────────────────────────────────────

describe("extractMessage", () => {
  it("extracts chatId, userId and text from a valid text update", () => {
    const update = {
      update_id: 42,
      message: {
        chat: { id: 100 },
        from: { id: 7 },
        text: "hello agent",
      },
    };
    expect(extractMessage(update)).toEqual({ chatId: 100, userId: 7, text: "hello agent" });
  });

  it("returns null for an update without a message", () => {
    expect(extractMessage({ update_id: 1 })).toBeNull();
  });

  it("returns null when message has no text (e.g. photo update)", () => {
    const update = {
      update_id: 2,
      message: { chat: { id: 1 }, from: { id: 2 }, photo: [] },
    };
    expect(extractMessage(update)).toBeNull();
  });
});
