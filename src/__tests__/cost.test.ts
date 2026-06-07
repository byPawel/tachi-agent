import { describe, it, expect } from "vitest";
import { estimateCost, TOOL_COST_USD } from "../cost.js";

describe("estimateCost", () => {
  it("sums known cloud tools (jury is the priciest fan-out)", () => {
    const usd = estimateCost([
      { name: "tachibot_jury", args: {}, result: "" },
      { name: "tachibot_grok_search", args: {}, result: "" },
    ]);
    expect(usd).toBeCloseTo(TOOL_COST_USD.tachibot_jury + TOOL_COST_USD.tachibot_grok_search, 5);
  });

  it("treats dokoro/memory tools as free", () => {
    expect(estimateCost([{ name: "dokoro_dokoro_session_recall", args: {}, result: "" }])).toBe(0);
  });

  it("falls back to a small default for an unknown tool, never NaN", () => {
    const usd = estimateCost([{ name: "tachibot_some_new_tool", args: {}, result: "" }]);
    expect(usd).toBeGreaterThan(0);
    expect(Number.isFinite(usd)).toBe(true);
  });

  it("is 0 for an empty run", () => {
    expect(estimateCost([])).toBe(0);
  });

  it("charges the default cost for a tool named like an Object.prototype key (no poisoned sum)", () => {
    // `name in TOOL_COST_USD` also matches inherited prototype keys, so a tool
    // literally named "toString" would resolve to the inherited function → NaN →
    // the finiteness guard would zero the WHOLE run. The lookup must use
    // Object.hasOwn so such a name falls back to the default per-tool cost.
    const usd = estimateCost([{ name: "toString", args: {}, result: "" }]);
    expect(Number.isFinite(usd)).toBe(true);
    expect(usd).toBeGreaterThan(0);
    expect(usd).toBeCloseTo(0.01, 5);
  });
});
