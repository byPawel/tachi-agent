// src/swarm/__tests__/synthesis.test.ts
import { describe, it, expect } from "vitest";
import { buildSynthesisPrompt } from "../synthesis.js";

describe("buildSynthesisPrompt", () => {
  const members = [
    { role: "implementer", answer: "Do X.", haltedBy: "final-answer" as const, costUsd: 0 },
    { role: "critic", answer: "X breaks on Y.", haltedBy: "final-answer" as const, costUsd: 0 },
  ];
  it("includes the task and every member's labeled answer", () => {
    const p = buildSynthesisPrompt("solve Z", members);
    expect(p).toContain("solve Z");
    expect(p).toContain("implementer");
    expect(p).toContain("Do X.");
    expect(p).toContain("critic");
    expect(p).toContain("X breaks on Y.");
  });
  it("instructs a single merged answer and omits empty-answer members", () => {
    const p = buildSynthesisPrompt("t", [...members, { role: "researcher", answer: "", haltedBy: "timeout" as const, costUsd: 0 }]);
    expect(p).not.toContain("researcher"); // empty answer excluded
    expect(p.toLowerCase()).toMatch(/single|one|synthesi/);
  });
});
