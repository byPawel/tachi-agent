import { describe, it, expect } from "vitest";
import { nsName, parseNs, isAllowed } from "../mcp.js";

describe("nsName", () => {
  it("joins server and tool with an underscore", () => {
    expect(nsName("tachibot", "jury")).toBe("tachibot_jury");
  });
});

describe("parseNs", () => {
  it("splits on the first underscore for a multi-underscore tool name", () => {
    expect(parseNs("dokoro_session_recall")).toEqual({ server: "dokoro", tool: "session_recall" });
  });

  it("splits on the first underscore for a single-underscore name", () => {
    expect(parseNs("tachibot_jury")).toEqual({ server: "tachibot", tool: "jury" });
  });
});

describe("isAllowed", () => {
  it("returns true when allow is undefined", () => {
    expect(isAllowed("tachibot_jury")).toBe(true);
  });

  it("returns true when allow is an empty array", () => {
    expect(isAllowed("tachibot_jury", [])).toBe(true);
  });

  it("returns true for an exact match in the allow list", () => {
    expect(isAllowed("dokoro_session_recall", ["dokoro_session_recall"])).toBe(true);
  });

  it("returns false when the allow list has entries but none match", () => {
    expect(isAllowed("tachibot_jury", ["dokoro_session_recall"])).toBe(false);
  });

  it("returns true for a prefix match via trailing underscore entry", () => {
    expect(isAllowed("tachibot_jury", ["tachibot_"])).toBe(true);
  });
});
