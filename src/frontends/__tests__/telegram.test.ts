import { describe, it, expect, vi } from "vitest";
import { parseAllowedIds, isAuthorized, extractMessage, getSession, truncateForTelegram } from "../telegram.js";
import type { ChatSession } from "../../chat-commands.js";

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

// ─── truncateForTelegram ─────────────────────────────────────────────────────

describe("truncateForTelegram", () => {
  it("passes through text under 4096 chars unchanged", () => {
    const text = "a".repeat(100);
    expect(truncateForTelegram(text)).toBe(text);
  });

  it("passes through text exactly 4096 chars unchanged", () => {
    const text = "a".repeat(4096);
    expect(truncateForTelegram(text)).toBe(text);
  });

  it("truncates text over 4096 chars and appends a marker", () => {
    const text = "a".repeat(5000);
    const result = truncateForTelegram(text);
    expect(result.length).toBeLessThanOrEqual(4096);
    expect(result.endsWith("…[truncated]")).toBe(true);
  });

  it("truncated result is at most 4096 chars", () => {
    const text = "b".repeat(10000);
    expect(truncateForTelegram(text).length).toBeLessThanOrEqual(4096);
  });
});

// ─── getSession ──────────────────────────────────────────────────────────────

describe("getSession", () => {
  it("creates a new session for an unknown chatId (no driver or skill set)", () => {
    const sessions = new Map<number, ChatSession & { lastSeen: number }>();
    const session = getSession(sessions, 42);
    expect(sessions.has(42)).toBe(true);
    // ChatSession fields — newly created session has no driver or skill
    expect(session.driver).toBeUndefined();
    expect(session.skill).toBeUndefined();
  });

  it("returns the same session object on repeated calls", () => {
    const sessions = new Map<number, ChatSession & { lastSeen: number }>();
    const s1 = getSession(sessions, 10);
    s1.driver = "openai";
    const s2 = getSession(sessions, 10);
    expect(s2.driver).toBe("openai");
    expect(s1).toBe(s2);
  });

  it("updates lastSeen on each access", () => {
    let t = 1000;
    const sessions = new Map<number, ChatSession & { lastSeen: number }>();
    getSession(sessions, 1, () => t);
    expect(sessions.get(1)!.lastSeen).toBe(1000);
    t = 2000;
    getSession(sessions, 1, () => t);
    expect(sessions.get(1)!.lastSeen).toBe(2000);
  });

  it("evicts the least-recently-used entry when the cap (200) is exceeded", () => {
    let t = 0;
    const sessions = new Map<number, ChatSession & { lastSeen: number }>();

    // Fill to cap with chatIds 1..200, each accessed at a different time
    for (let i = 1; i <= 200; i++) {
      t = i; // chatId i last seen at time i
      getSession(sessions, i, () => t);
    }
    expect(sessions.size).toBe(200);

    // Chat 1 is the LRU (lastSeen = 1). Adding chat 201 should evict chat 1.
    t = 201;
    getSession(sessions, 201, () => t);
    expect(sessions.size).toBe(200);
    expect(sessions.has(1)).toBe(false);  // evicted
    expect(sessions.has(201)).toBe(true); // just added
  });

  it("evicts LRU not the most-recently-used entry", () => {
    let t = 0;
    const sessions = new Map<number, ChatSession & { lastSeen: number }>();

    // Fill to 200
    for (let i = 1; i <= 200; i++) {
      t = i;
      getSession(sessions, i, () => t);
    }

    // Refresh chat 1 so it's now the most-recently-used
    t = 999;
    getSession(sessions, 1, () => t);

    // Now chat 2 is the LRU (lastSeen = 2). Adding chat 201 should evict chat 2.
    t = 1001;
    getSession(sessions, 201, () => t);
    expect(sessions.has(2)).toBe(false);  // evicted
    expect(sessions.has(1)).toBe(true);   // survived (recently refreshed)
  });
});
