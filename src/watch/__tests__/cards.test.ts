import { describe, expect, it } from "vitest";
import { confidenceMeter, councilPhases, toolCard } from "../cards.js";

const plain = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x07]*\x07/g, "");

describe("tool cards", () => {
  it("jev_decide: probability bars", () => {
    const out = JSON.stringify({ answers: { pick: { choice: "d", probabilities: { d: 0.93, c: 0.05 } } } });
    const t = plain(toolCard("jev_decide", out, 60));
    expect(t).toMatch(/d .*█.* 0\.93/);
    expect(t).toMatch(/pick → d/);
  });

  it("search: source count and domain chips", () => {
    const t = plain(toolCard("grok_search", "a https://github.com/x b https://github.com/y c https://npmjs.com/z", 80));
    expect(t).toContain("3 sources");
    expect(t).toContain("github.com ×2");
  });

  it("any tool: degraded banner", () => {
    const t = plain(toolCard("openai_reason", "[degraded: gpt-6-astra unavailable — timeout; answered by gpt-6-sol]\nanswer", 80));
    expect(t).toContain("↳ gpt-6-astra → gpt-6-sol");
    expect(t).toContain("timeout");
  });

  it("diff_review: merge badge and severity counts", () => {
    const t = plain(toolCard("diff_review", "Verdict: NOT MERGEABLE\n- critical: a\n- major: b\n- major: c", 80));
    expect(t).toContain("NOT MERGEABLE");
    expect(t).toContain("1 critical");
    expect(t).toContain("2 major");
  });

  it("planner: checklist progress", () => {
    const t = plain(toolCard("planner_maker", "- [x] a\n- [x] b\n- [ ] c\n- [ ] d\n- [ ] e\n- [ ] f", 60));
    expect(t).toContain("2 / 6 done");
  });

  it("debug_triage: ranked hypotheses", () => {
    const t = plain(toolCard("debug_triage", "1. stale MCP process (72%)\n2. env not reloaded (20%)", 60));
    expect(t).toMatch(/1 .*stale MCP process.*72%/);
  });

  it("unknown tool, plain text: nothing", () => {
    expect(toolCard("qwen_coder", "just text", 60)).toEqual([]);
  });

  it("truncated JSON falls back", () => {
    expect(toolCard("jev_decide", '{"answers":{"pick":', 60)).toEqual([]);
  });
});

describe("council", () => {
  const at = (tool: string, i: number) => ({ tool, status: "ok", ts: 1000 + i });
  it("finds the phases that ran, ending at the resolver", () => {
    const calls = ["grok_search", "perplexity_ask", "jev_decide", "grok_reason", "kimi_thinking", "nextThought", "gemini_judge"].map(at);
    expect(councilPhases(calls).map((p) => p.label)).toEqual(["Research", "Evidence", "Debate", "Reasoning", "Resolution"]);
  });
  it("no resolver, no council", () => {
    expect(councilPhases([at("grok_search", 0)])).toEqual([]);
  });
  it("confidence meter", () => {
    expect(confidenceMeter("…\nConfidence: Medium — evidence thin")).toContain("MEDIUM");
    expect(confidenceMeter("no rating")).toBeUndefined();
  });
});

describe("more cards", () => {
  it("jury: roster chips with dropped jurors", () => {
    const t = plain(toolCard("jury", "verdict…\n- A: Grok (first-principles)\n- B: DeepSeek (math)\n- Kimi (edge cases) — DROPPED (provider error or quota)", 80));
    expect(t).toContain("panel 2/3");
    expect(t).toContain("A Grok ✓");
    expect(t).toContain("Kimi ✗");
  });
  it("usage_stats: table column as bars", () => {
    const t = plain(toolCard("usage_stats", "| tool | calls |\n|---|---|\n| grok | 10 |\n| kimi | 5 |", 60));
    expect(t).toMatch(/grok .*█.* 10/);
    expect(t).toMatch(/kimi .*█.* 5/);
  });
});

describe("council panel", () => {
  it("draws phases, role cards and the verdict for the resolver call", async () => {
    const { councilPanel } = await import("../cards.js");
    const t = (tool: string, ts: number, output = "A long enough first point about the decision at hand here.", status = "ok") => ({ tool, ts, status, ms: 1000, output });
    const calls = [t("grok_search", 1), t("jev_decide", 2, JSON.stringify({ answers: { pick: { choice: "d", probabilities: { d: 0.93, c: 0.05 } } } })), t("grok_reason", 3), t("kimi_thinking", 4, "[truncated: hit max_tokens=3000] Risks: continuation multiplies cost and latency badly."), t("openai_reason", 5), t("nextThought", 6)];
    const judge = { ...t("gemini_judge", 7, "## Recommendation\nRaise caps and split delivery now.\n1. caps 3k to 12k\n2. persist full output\nConfidence: Medium"), input: "question: How should tachibot handle truncation?" };
    const out = councilPanel([...calls, judge], judge, 100).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    for (const s of ["COUNCIL", "How should tachibot handle truncation?", "Research", "Resolution", "FOR · grok", "AGAINST · kimi", "truncated", "CALIBRATION", "VERDICT", "■■□ MEDIUM", "Raise caps and split delivery now.", "persist full output"]) expect(out).toContain(s);
  });
});

describe("jev legend + verdict sections", () => {
  it("labels score levels from a legend map and flags low confidence", async () => {
    const out = JSON.stringify({ answers: { risk: { type: "score", score: 0.74, legend: { "0": "low", "1": "medium", "2": "high" }, probabilities: { "0": 0.31, "1": 0.64, "2": 0.05 }, confidence: 0.46 } } });
    const t = plain(toolCard("jev_decide", out, 70));
    expect(t).toMatch(/risk → medium/);
    expect(t).toContain("low confidence");
    expect(t).toMatch(/high .*0\.05/);
  });
  it("takes the verdict from the heading section and steps from the actions section", async () => {
    const { councilPanel } = await import("../cards.js");
    const t = (tool: string, ts: number, output = "A long enough first point about the decision at hand here.") => ({ tool, ts, status: "ok", ms: 1000, output });
    const judge = { ...t("gemini_judge", 9, "The council was not blind. Raise caps first.\n\n1. Definitive Recommendation\nShip guarded D: caps plus split delivery.\n\n3. First 3 Actions\n- persist the full output\n- add a status footer\n- verify limits\n\nConfidence: Medium"), input: "question: Q?" };
    const out = councilPanel([t("grok_search", 1), t("grok_reason", 2), t("nextThought", 3), judge], judge, 90).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    expect(out).toContain("Ship guarded D: caps plus split delivery.");
    expect(out).toContain("1 persist the full output");
    expect(out).not.toContain("Definitive Recommendation");
  });
});

describe("firstPoint", () => {
  it("joins hard-wrapped lines and ends on a sentence", async () => {
    const { firstPoint } = await import("../cards.js");
    expect(firstPoint("🧠 THE MEDIUM ───\n\nThe rich job is not a log line. It is full MCP input\nand output, nested model calls, and notes.")).toBe("The rich job is not a log line. It is full MCP input and output, nested model calls, and notes.");
  });
});

describe("planner card", () => {
  const out = `  planner_maker \n\n███░░░░░░░ Step 3/10 · Analysis\n\n💭 Why This Step\n\nStep-by-step reasoning. Kimi breaks tasks into ordered steps.\n\nNext → kimi_thinking · Step-by-step reasoning (Kimi)\n📄 Live plan: /tmp/dokoro/daily/2026-10-31-plan-x.md\n\n▶ Execute kimi_thinking, then: planner_maker({ mode: "continue", step: 4, prior: { ...prior, analyze_kimi: FULL_RESULT } })\nIMPORTANT: Pass the COMPLETE tool output as analyze_kimi — do NOT summarize.`;
  it("parses step, why, next, plan and the handoff", async () => {
    const { parsePlanner, plannerCard } = await import("../cards.js");
    const p = parsePlanner(out)!;
    expect(p).toMatchObject({ step: 3, total: 10, phase: "Analysis", next: { tool: "kimi_thinking" }, plan: "/tmp/dokoro/daily/2026-10-31-plan-x.md", handoff: { step: 4, key: "analyze_kimi" } });
    expect(p.why).toMatch(/^Step-by-step reasoning/);
    const plain = plannerCard(p, 60).map((l) => l.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x07]*\x07/g, ""));
    expect(plain[0]).toMatch(/^▀+ ▀+ ▀+/);
    expect(plain).toContain("Step 3 of 10 · Analysis");
    expect(plain.some((l) => l.includes("→ kimi_thinking"))).toBe(true);
    expect(plain.some((l) => l.includes("step 4 as") && l.includes("analyze_kimi"))).toBe(true);
    expect(plain.some((l) => l.includes("plan-x"))).toBe(true);
  });
});

describe("drag selection", () => {
  it("selects inside the pane the drag started in", async () => {
    const { selectText } = await import("../ui.js");
    const rows = ["│ list one  │ ┃ alpha beta gamma   ▐ ┃", "│ list two  │ ┃ delta epsilon      ▐ ┃"];
    expect(selectText(rows, { x: 17, y: 1 }, { x: 23, y: 2 })).toBe("alpha beta gamma\ndelta e");
    expect(selectText(rows, { x: 3, y: 1 }, { x: 10, y: 1 })).toBe("list one");
  });
});

describe("code highlighting", () => {
  it("colors keywords, strings and numbers, keeps the text", async () => {
    const { highlight, visible } = await import("../md.js");
    const l = highlight('const a = "x"; // note 42');
    expect(visible(l)).toBe('const a = "x"; // note 42');
    expect(l).toContain("\x1b[38;2;210;168;255mconst");
  });
});

describe("drag selection outside panes", () => {
  it("never selects from the header or tab bar", async () => {
    const { selectText } = await import("../ui.js");
    expect(selectText(["tachi-watch · 18d7a7df", "40 calls  1 errors"], { x: 1, y: 1 }, { x: 10, y: 2 })).toBe("");
  });
});
