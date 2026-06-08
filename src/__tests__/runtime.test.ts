import { describe, it, expect } from "vitest";
import { DEFAULT_ALLOW } from "../runtime.js";

describe("DEFAULT_ALLOW (curated small allowlist)", () => {
  it("includes the high-leverage multi-model tools", () => {
    expect(DEFAULT_ALLOW).toContain("tachibot_jury");
    expect(DEFAULT_ALLOW).toContain("tachibot_tachi"); // smart router entry point
    expect(DEFAULT_ALLOW).toContain("tachibot_planner_maker"); // council planning
    expect(DEFAULT_ALLOW).toContain("tachibot_grok_reason");
    expect(DEFAULT_ALLOW).toContain("tachibot_grok_code");
    expect(DEFAULT_ALLOW).toContain("tachibot_grok_debug");
    expect(DEFAULT_ALLOW).toContain("tachibot_grok_architect");
    expect(DEFAULT_ALLOW).toContain("tachibot_grok_brainstorm");
    expect(DEFAULT_ALLOW).toContain("tachibot_grok_search");
    expect(DEFAULT_ALLOW).toContain("tachibot_gemini_query");
    expect(DEFAULT_ALLOW).toContain("tachibot_gemini_brainstorm");
    expect(DEFAULT_ALLOW).toContain("tachibot_gemini_analyze_code");
    expect(DEFAULT_ALLOW).toContain("tachibot_gemini_analyze_text");
    expect(DEFAULT_ALLOW).toContain("tachibot_gemini_summarize");
    expect(DEFAULT_ALLOW).toContain("tachibot_gemini_judge");
    expect(DEFAULT_ALLOW).toContain("tachibot_gemini_search");
    expect(DEFAULT_ALLOW).toContain("tachibot_perplexity_ask");
    expect(DEFAULT_ALLOW).toContain("tachibot_perplexity_research");
    expect(DEFAULT_ALLOW).toContain("tachibot_perplexity_reason");
    expect(DEFAULT_ALLOW).toContain("tachibot_perplexity_fact_check");
    expect(DEFAULT_ALLOW).toContain("tachibot_perplexity_code_search");
    expect(DEFAULT_ALLOW).toContain("tachibot_qwen_reason");
    expect(DEFAULT_ALLOW).toContain("tachibot_qwen_general");
    expect(DEFAULT_ALLOW).toContain("tachibot_qwen_coder");
    expect(DEFAULT_ALLOW).toContain("tachibot_qwen_algo");
    expect(DEFAULT_ALLOW).toContain("tachibot_qwen_competitive");
  });

  it("keeps direct Gemini tools for explicit user routing", () => {
    expect(DEFAULT_ALLOW).toContain("tachibot_gemini_judge");
  });

  it("does not add a non-existent tachibot_council tool", () => {
    expect(DEFAULT_ALLOW).not.toContain("tachibot_council");
  });

  it("keeps the dokoro memory tools (recall + summary_add discovered by suffix)", () => {
    expect(DEFAULT_ALLOW).toContain("dokoro_dokoro_session_recall");
    expect(DEFAULT_ALLOW).toContain("dokoro_dokoro_session_summary_add");
    // session_log writes a different store recall() never reads — must NOT be used.
    expect(DEFAULT_ALLOW).not.toContain("dokoro_dokoro_session_log");
  });

  it("stays bounded — a 3–8B local model drowns with the full tool surface", () => {
    expect(DEFAULT_ALLOW.length).toBeLessThanOrEqual(35);
  });
});
