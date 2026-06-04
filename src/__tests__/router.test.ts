import { describe, it, expect } from "vitest";
import { needsGroundingSearch } from "../router.js";

describe("needsGroundingSearch (force-search router)", () => {
  it("triggers on a domain/URL", () => {
    expect(needsGroundingSearch("what is tachibot.com")).toBe(true);
    expect(needsGroundingSearch("compare langchain.io and crewai")).toBe(true);
  });
  it("triggers on 'what is X' / 'who is X'", () => {
    expect(needsGroundingSearch("what is LangGraph?")).toBe(true);
    expect(needsGroundingSearch("who is the author of this library")).toBe(true);
  });
  it("triggers on entity-ask phrasing", () => {
    expect(needsGroundingSearch("tell me about the MCP spec")).toBe(true);
    expect(needsGroundingSearch("look up the latest qwen release")).toBe(true);
  });
  it("does NOT trigger on plain reasoning/chat", () => {
    expect(needsGroundingSearch("summarize this paragraph")).toBe(false);
    expect(needsGroundingSearch("hi there")).toBe(false);
    expect(needsGroundingSearch("write a haiku about the sea")).toBe(false);
  });
});
