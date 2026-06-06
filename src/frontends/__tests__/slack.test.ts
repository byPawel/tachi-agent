import { describe, it, expect } from "vitest";
import { parseAllowedSlackIds, isSlackAuthorized, extractSlackMessage } from "../slack.js";

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

describe("extractSlackMessage", () => {
  it("extracts channel, userId and text from a plain user message", () => {
    const event = { type: "message", channel: "C100", user: "U7", text: "hello agent", ts: "1.2" };
    expect(extractSlackMessage(event)).toEqual({ channel: "C100", userId: "U7", text: "hello agent" });
  });
  it("strips a leading @-mention from app_mention text", () => {
    const event = { type: "app_mention", channel: "C1", user: "U7", text: "<@U0BOT> do the thing", ts: "1.2" };
    expect(extractSlackMessage(event)).toEqual({ channel: "C1", userId: "U7", text: "do the thing" });
  });
  it("returns null for a bot message (has bot_id) — prevents self-reply loops", () => {
    const event = { type: "message", channel: "C1", user: "U7", text: "hi", bot_id: "B1", ts: "1.2" };
    expect(extractSlackMessage(event)).toBeNull();
  });
  it("returns null for a message subtype (edit/join/etc.)", () => {
    const event = { type: "message", subtype: "message_changed", channel: "C1", user: "U7", text: "x", ts: "1.2" };
    expect(extractSlackMessage(event)).toBeNull();
  });
  it("returns null when there is no text", () => {
    expect(extractSlackMessage({ type: "message", channel: "C1", user: "U7", ts: "1.2" })).toBeNull();
  });
  it("returns null for a non-message event type", () => {
    expect(extractSlackMessage({ type: "reaction_added", channel: "C1", user: "U7" })).toBeNull();
  });
});
