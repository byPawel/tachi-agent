import { describe, it, expect } from "vitest";
import { needsGroundingSearch, needsCouncil } from "../router.js";

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

describe("needsCouncil (council-as-planner router)", () => {
  it("triggers on compare / vs / tradeoff intents", () => {
    expect(needsCouncil("compare Postgres and DynamoDB for our load")).toBe(true);
    expect(needsCouncil("React vs Vue vs Svelte for this app")).toBe(true);
    expect(needsCouncil("what are the tradeoffs of a monorepo")).toBe(true);
  });
  it("triggers on architecture / design / decision intents", () => {
    expect(needsCouncil("design the auth architecture for multi-tenant")).toBe(true);
    expect(needsCouncil("should I use Redis or Memcached here?")).toBe(true);
    expect(needsCouncil("which database is best for time-series?")).toBe(true);
  });
  it("triggers on plural / second-person decision framings (not just 'should I')", () => {
    expect(needsCouncil("should we use Redis or Memcached?")).toBe(true);
    expect(needsCouncil("should you go with Postgres or MySQL?")).toBe(true);
  });
  it("does NOT trigger on plain chat / single-fact / generation", () => {
    expect(needsCouncil("write a haiku about the sea")).toBe(false);
    expect(needsCouncil("summarize this paragraph")).toBe(false);
    expect(needsCouncil("hi there")).toBe(false);
  });
  it("does NOT trigger on generation tasks or incidental 'design' mentions", () => {
    expect(needsCouncil("design a function that adds two numbers")).toBe(false);
    expect(needsCouncil("design a logo")).toBe(false);
    expect(needsCouncil("the design is nice")).toBe(false);
    expect(needsCouncil("this design works")).toBe(false);
  });
  it("does NOT trigger on content-blind 'which' chatter", () => {
    expect(needsCouncil("which color is nicer")).toBe(false);
    expect(needsCouncil("which one is correct")).toBe(false);
    expect(needsCouncil("which file should I open")).toBe(false);
  });
});
