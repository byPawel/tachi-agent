import { describe, it, expect } from "vitest";
import { parseAllowSet, toolEmoji, mdBoldHeadings, formatStepEvent } from "../shared.js";

describe("parseAllowSet", () => {
  it("returns an empty set for undefined/empty (fail-closed)", () => {
    expect(parseAllowSet(undefined).size).toBe(0);
    expect(parseAllowSet("").size).toBe(0);
  });
  it("splits on commas, trims, drops blanks", () => {
    expect([...parseAllowSet(" a, b ,,c ")]).toEqual(["a", "b", "c"]);
  });
});

describe("mdBoldHeadings", () => {
  it("converts **bold** and # headings to single-asterisk", () => {
    expect(mdBoldHeadings("**hi** there")).toBe("*hi* there");
    expect(mdBoldHeadings("### Title\nbody")).toBe("*Title*\nbody");
  });
});

describe("toolEmoji", () => {
  it("maps known tool-name fragments", () => {
    expect(toolEmoji("tachibot_jury")).toBe("⚖️");
    expect(toolEmoji("tachibot_grok_search")).toBe("🔍");
    expect(toolEmoji("dokoro_dokoro_session_recall")).toBe("🧠");
    expect(toolEmoji("anything_else")).toBe("🔧");
  });
});

describe("formatStepEvent", () => {
  it("renders step / tool-call / tool-result lines and nulls the rest", () => {
    expect(formatStepEvent({ type: "step", iteration: 2 })).toBe("⚙️ step 2");
    expect(
      formatStepEvent({ type: "assistant", content: "", toolCalls: [{ name: "tachibot_jury", arguments: {} }] }),
    ).toBe("⚖️ tachibot_jury…");
    expect(formatStepEvent({ type: "tool-result", name: "tachibot_jury", result: "ok" })).toBe("   ✅ tachibot_jury");
    expect(formatStepEvent({ type: "assistant", content: "final", toolCalls: [] })).toBeNull();
    expect(formatStepEvent({ type: "cost", usd: 0, calls: 0 })).toBeNull();
  });
});
