import { describe, it, expect } from "vitest";
import { followIndex, groupItems, wrap } from "../ui.js";
import { buildCallReviewPrompt } from "../policy.js";
import { formatArgs } from "../events.js";
import type { Card } from "../store.js";

const card = (c: Partial<Card>): Card => ({ key: "k", type: "tool", title: "t", status: "ok", ts: 1, depth: 0, source: "claude", ...c });

describe("tachibot-only pane", () => {
  it("groups calls with their models and notes; drops plain Claude tools", () => {
    const items = groupItems([
      card({ key: "b1", title: "Bash" }), // not shown
      card({ key: "j", via: "tachibot", title: "tachibot · jury" }),
      card({ key: "m1", type: "span", depth: 1, title: "grok:grok-4.7", source: "tachibot" }),
      card({ key: "n1", type: "note", source: "watch", about: "j", cite: "CLAUDE.md:3", output: "contradicts X" }),
      card({ key: "s", type: "status", source: "watch", output: "brain → codex" }),
    ]);
    expect(items).toHaveLength(1); // statuses go to the status line, not the list
    expect(items[0].call?.key).toBe("j");
    expect(items[0].models.map((m) => m.key)).toEqual(["m1"]);
    expect(items[0].notes.map((n) => n.key)).toEqual(["n1"]);
  });

  it("shows top-level trace spans with no transcript card as calls", () => {
    const items = groupItems([card({ key: "tb:1", type: "span", depth: 0, title: "tool jury", tool: "jury", source: "tachibot" })]);
    expect(items[0].call).toMatchObject({ via: "tachibot", title: "tachibot · jury" });
  });

  it("follows the most recently finished call, not a newer running one", () => {
    const items = groupItems([
      card({ key: "a", via: "tachibot", ts: 1000, ms: 9000, status: "ok" }),   // perplexity, done at 10s
      card({ key: "b", via: "tachibot", ts: 2000, status: "running" }),        // grok, still running
    ]);
    expect(items[followIndex(items)].call?.key).toBe("a");
    expect(followIndex(groupItems([card({ key: "r", via: "tachibot", status: "running" })]))).toBe(0);
  });

  it("re-attaches restored notes that come before their replayed call", () => {
    const items = groupItems([
      card({ key: "n1", type: "note", source: "watch", about: "j", ts: 50, output: "restored" }),
      card({ key: "j", via: "tachibot", title: "tachibot · jury", ts: 10 }),
      card({ key: "q", type: "answer", source: "watch", ts: 60, input: "why?", output: "because" }),
    ]);
    // a chat answer without a call lives in the chat view, not the calls list
    expect(items.map((i) => (i.call ?? i.loose)!.key)).toEqual(["j"]);
    expect(items[0].notes.map((n) => n.key)).toEqual(["n1"]);
  });

  it("hard-wraps to the pane width", () => {
    expect(wrap("aaa bbb ccc", 7)).toEqual(["aaa bbb", "ccc"]);
    expect(wrap("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
    expect(wrap("a\n\nb", 10)).toEqual(["a", "", "b"]);
  });

  it("formats every argument and builds the per-call review prompt", () => {
    expect(formatArgs({ question: "safe?", jurors: "grok,openai", n: 3 })).toBe("question: safe?\njurors: grok,openai\nn: 3");
    const p = buildCallReviewPrompt(
      { title: "tachibot · jury", input: "question: safe?", output: "verdict: use gpt-6-astra", status: "fallback", models: ["grok ok"] },
      ["is it safe?"],
      [{ source: "memory/tool-description-policy.md:1", text: "never pin model versions" }],
    );
    expect(p).toContain("User recently asked:\n- is it safe?");
    expect(p).toContain("[memory/tool-description-policy.md:1]");
    expect(p).toContain("tachibot call: tachibot · jury (fallback)\nmodels: grok ok");
    expect(p).toContain("OUTPUT:\nverdict: use gpt-6-astra");
    const long = "x".repeat(15_000);
    expect(buildCallReviewPrompt({ title: "t", output: long, status: "ok" }, [], [])).toContain(long); // never cut before the reviewer
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSaved, saveCards } from "../persist.js";

describe("resume", () => {
  it("saves only the brain's notes and answers, and restores them", () => {
    const home = mkdtempSync(join(tmpdir(), "watch-resume-"));
    saveCards("sess/1", [
      card({ key: "j", via: "tachibot" }),
      card({ key: "n", type: "note", source: "watch", about: "j", output: "x" }),
      card({ key: "a", type: "answer", source: "watch", input: "q?", output: "a" }),
      card({ key: "s", type: "status", source: "watch", output: "brain → codex" }),
    ], home);
    expect(loadSaved("sess/1", home).map((c) => c.key)).toEqual(["n", "a"]);
    expect(loadSaved("other", home)).toEqual([]);
    rmSync(home, { recursive: true, force: true });
  });
});

describe("chat + markdown", () => {
  it("renders markdown without raw markers", async () => {
    const { renderMarkdown } = await import("../md.js");
    const plain = renderMarkdown("## Plan\n- **bold** and `code`\n| a | b |\n|---|---|\n| 1 | 2 |", 60)
      .map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
    expect(plain.join("\n")).not.toMatch(/\*\*|##|\|---/);
    expect(plain).toContain("▍ Plan");
    expect(plain.some((l) => l.startsWith("• bold and code"))).toBe(true);
  });

  it("numbers You/Watcher turns and shows the pending question at once", async () => {
    const { chatLines } = await import("../ui.js");
    const cards = [
      { key: "a", type: "answer", source: "watch", depth: 0, ts: 1, status: "info", title: "watch", input: "why?", output: "because" },
    ] as never[];
    const text = chatLines(cards, { question: "and now?", since: 0 }, 60, 5000).map((l) => l.text.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
    expect(text).toMatch(/You #1[^\n]*\nwhy\?/);
    expect(text).toMatch(/Watcher #1/);
    expect(text).toMatch(/You #2[^\n]*\nand now\?/);
    expect(text).toMatch(/thinking… 5s/);
  });
});

describe("links", () => {
  it("turns markdown and bare URLs into OSC 8 hyperlinks", async () => {
    const { renderMarkdown } = await import("../md.js");
    const out = renderMarkdown("see [docs](https://a.dev/x) and https://b.dev/y.", 80).join("\n");
    expect(out).toContain("\x1b]8;;https://a.dev/x\x07");
    expect(out).toContain("\x1b]8;;https://b.dev/y\x07"); // trailing "." not part of the URL
    expect(out.replace(/\x1b\][^\x07]*\x07|\x1b\[[0-9;]*m/g, "")).toBe("see docs and https://b.dev/y.");
  });
});

describe("formatting fixes", () => {
  it("wraps by terminal columns (emoji are 2 wide)", async () => {
    const { wrap } = await import("../ui.js");
    for (const l of wrap("💬💬💬💬💬💬 abc def", 8)) expect((await import("string-width")).default(l)).toBeLessThanOrEqual(8);
  });

  it("coalesces consecutive loose notes into one brain row", async () => {
    const { groupItems } = await import("../ui.js");
    const note = (k: string, ts: number) => ({ key: k, type: "note", source: "watch", depth: 0, ts, status: "info", title: "watch", output: k });
    const call = { key: "c1", type: "tool", via: "tachibot", source: "claude", depth: 0, ts: 10, status: "ok", title: "tachibot · x" };
    const items = groupItems([note("a", 1), note("b", 2), note("c", 3), call, note("d", 20)] as never[]);
    expect(items).toHaveLength(3);
    expect(items[0].group?.map((n) => n.output)).toEqual(["a", "b", "c"]);
    expect(items[2].group).toBeUndefined();
  });

  it("turns citations in tachibot's ANSI output into clickable [n] without breaking its colors", async () => {
    const { linkifyAnsi, visible } = await import("../md.js");
    const out = linkifyAnsi("\x1b[1mbold\x1b[22m see [[5]](https://npmjs.com/p) end");
    expect(out).toContain("\x1b]8;;https://npmjs.com/p\x07");
    expect(out.startsWith("\x1b[1mbold\x1b[22m")).toBe(true);
    expect(visible(out)).toBe("bold see [5] end");
  });
});

describe("components", () => {
  it("splits FOLLOWUPS off an answer", async () => {
    const { splitFollowUps } = await import("../components.js");
    expect(splitFollowUps("Answer.\n\nFOLLOWUPS: why? | what next? | and Kimi?")).toEqual({ text: "Answer.", followups: ["why?", "what next?", "and Kimi?"] });
    expect(splitFollowUps("no list")).toEqual({ text: "no list", followups: [] });
  });

  it("gives every chat line a speaker gutter", async () => {
    const { chatLines } = await import("../ui.js");
    const cards = [{ key: "a", type: "answer", source: "watch", depth: 0, ts: 1, status: "info", title: "watch", input: "q", output: "a" }] as never[];
    const lines = chatLines(cards, undefined, 40).filter((l) => l.text);
    expect(lines.every((l) => l.bar)).toBe(true);
    expect(new Set(lines.map((l) => l.bar))).toEqual(new Set(["#f0f6fc", "#79c0ff"]));
  });
});

describe("design pieces", () => {
  const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  it("draws Steps chips, a timeout gauge and short model names", async () => {
    const { stepsLine, gauge, shortModel, toolTimeoutMs } = await import("../components.js");
    expect(plain(stepsLine([{ label: "grok", status: "ok" }, { label: "kimi", status: "fallback" }]))).toBe(" ① grok ✓  ─  ② kimi ↳ ");
    expect(gauge(41_000, 600_000)).toBe("█░░░░░░░░░ 41/600s");
    expect(shortModel("openrouter:moonshotai/kimi-k3")).toBe("kimi-k3");
    expect(toolTimeoutMs("tachibot · kimi_thinking")).toBe(600_000);
  });

  it("types a fresh answer in, then shows it whole", async () => {
    const { chatLines, TYPE_MS } = await import("../ui.js");
    const card = { key: "a", type: "answer", source: "watch", depth: 0, ts: 1000, status: "info", title: "watch", input: "q", output: "abcdefghij" } as never;
    const at = (now: number) => chatLines([card], undefined, 40, now).map((l) => plain(l.text)).join("\n");
    expect(at(1000 + TYPE_MS / 2)).toMatch(/abcde▌/);
    expect(at(1000 + TYPE_MS + 1)).toMatch(/abcdefghij$/m);
  });
});

describe("reflow", () => {
  it("rejoins tachibot's soft wraps, keeps structure", async () => {
    const { reflow } = await import("../ui.js");
    expect(reflow("limits: $0.50 for quick or standard calls and\n more for deep ones.\n- item")).toBe("limits: $0.50 for quick or standard calls and more for deep ones.\n- item");
    expect(reflow("Short line\nnext line")).toBe("Short line\nnext line");
    expect(reflow("A long sentence that ends properly here, done.\nnext para")).toBe("A long sentence that ends properly here, done.\nnext para");
  });
});

describe("fitAnsi", () => {
  it("stacks a box table wider than the pane, keeps one that fits", async () => {
    const { fitAnsi } = await import("../ui.js");
    const table = "╭──────┬──────────────────╮\n│ Element │ Treatment │\n├──────┼──────────────────┤\n│ Success │ Small green marker │\n╰──────┴──────────────────╯";
    const stacked = fitAnsi(table, 20).replace(/\x1b\[[0-9;]*m/g, "");
    expect(stacked).toContain("Success");
    expect(stacked).toContain("Treatment: Small green marker");
    expect(stacked).not.toContain("│");
    expect(fitAnsi(table, 200)).toBe(table);
  });
  it("drops SGR codes that lost their ESC byte", async () => {
    const { fitAnsi } = await import("../ui.js");
    expect(fitAnsi("1mThe main lesson\n[1mC. Use it", 80)).toBe("The main lesson\nC. Use it");
    expect(fitAnsi("timeout 30m left", 80)).toBe("timeout 30m left");
  });
});

describe("search", () => {
  it("filters calls by every word across tool, input and output", async () => {
    const { filterItems, groupItems } = await import("../ui.js");
    const mk = (key: string, tool: string, input: string, full: string) => ({ key, type: "tool", via: "tachibot", source: "claude", depth: 0, ts: 1, status: "ok", title: `tachibot · ${tool}`, input, full });
    const items = groupItems([mk("a", "grok_search", "openui docs", "x"), mk("b", "kimi_thinking", "truncation", "caps raised")] as never[]);
    expect(filterItems(items, "kimi caps").map((i) => i.call!.key)).toEqual(["b"]);
    expect(filterItems(items, "OPENUI").map((i) => i.call!.key)).toEqual(["a"]);
    expect(filterItems(items, "")).toHaveLength(2);
  });
});

describe("time groups", () => {
  it("starts a group at the first call and after every gap over 5 minutes", async () => {
    const { timeGroups, groupItems } = await import("../ui.js");
    const mk = (key: string, ts: number) => ({ key, type: "tool", via: "tachibot", source: "claude", depth: 0, ts, status: "ok", title: "tachibot · x" });
    const g = timeGroups(groupItems([mk("a", 0), mk("b", 60_000), mk("c", 60_000 + 6 * 60_000)] as never[]));
    expect([...g.keys()]).toEqual([0, 2]);
  });
});

describe("question groups", () => {
  it("groups calls under the prompt before them, with your label winning", async () => {
    const { questionGroups, groupItems, cleanPrompt } = await import("../ui.js");
    const mk = (key: string, ts: number) => ({ key, type: "tool", via: "tachibot", source: "claude", depth: 0, ts, status: "ok", title: "tachibot · x" });
    const items = groupItems([mk("a", 5), mk("b", 15), mk("c", 16), mk("d", 30)] as never[]);
    const g = questionGroups(items, [{ ts: 10, text: "make it nicer?" }, { ts: 20, text: "[Image #3] fix  it" }], { "20": "fixes" });
    expect(g.map((x) => [x.label, x.start, x.end])).toEqual([["before this session", 0, 0], ["make it nicer?", 1, 2], ["fixes", 3, 3]]);
    expect(cleanPrompt('<pasted_content id="1">x</pasted_content id="1"> hello\n world')).toBe("hello world");
  });
});

describe("prompts", () => {
  const T = (name: string, useWhen: string, tier?: "core") => ({ name, alias: null, description: `${name} desc`, useWhen, example: "e", category: "reasoning", tier });
  it("ranks techniques for a task, name hits first", async () => {
    const { rankTechniques, techniqueMessage } = await import("../prompts.js");
    const list = [T("scot", "structured code reasoning"), T("pre_mortem", "before shipping a plan, find failure", "core"), T("reflexion", "iterate on failures")];
    expect(rankTechniques(list, "plan failure").map((t) => t.name)).toEqual(["pre_mortem", "reflexion"]);
    expect(rankTechniques(list, "")).toHaveLength(3);
    expect(techniqueMessage(list[1], "ship the watcher")).toMatch(/"pre_mortem".*ship the watcher.*preview_prompt_technique/);
  });
  it("loads the catalog from tachibot's build in the project", async () => {
    const { loadTechniques } = await import("../prompts.js");
    const { list, from } = await loadTechniques("/Users/gravity/Documents/WORK/TACHIBOT_ALL/tachibot-mcp").catch(() => ({ list: [], from: "missing" }));
    if (from !== "missing") expect(list.length).toBeGreaterThan(20);
  });
});

describe("prompt labels", () => {
  it("drops image tags, labels skill runs, skips harness turns", async () => {
    const { cleanPrompt } = await import("../ui.js");
    expect(cleanPrompt("[Image: source: /var/folders/x.png] fix broken design")).toBe("fix broken design");
    expect(cleanPrompt("Base directory for this skill: /Users/g/.claude/skills/council\n# Council\n…\nARGUMENTS: work on formatting")).toBe("/council work on formatting");
    expect(cleanPrompt("A session-scoped Stop hook is now active")).toBeUndefined();
  });
});

describe("tachibot chip header", () => {
  it("drops the provider/tool chip line at the top", async () => {
    const { fitAnsi } = await import("../ui.js");
    expect(fitAnsi("\x1b[42m openai \x1b[0m\x1b[45m openai_search \x1b[0m\n\nThe main lesson", 80)).toBe("\nThe main lesson");
  });
});

describe("command labels", () => {
  it("labels flattened skill and slash-command prompts", async () => {
    const { cleanPrompt } = await import("../ui.js");
    expect(cleanPrompt("Base directory for this skill: /Users/g/.claude/skills/council  # Council — Deep Multi-Model Deliber…")).toBe("/council");
    expect(cleanPrompt("`/design` was invoked: a request for a design … The brief: with open-ui in mind")).toBe("/design with open-ui in mind");
    expect(cleanPrompt("[Image #3]")).toBe("screenshot");
  });
});

describe("styleAnsi", () => {
  it("turns bold-only lines into headings and colors list markers", async () => {
    const { styleAnsi } = await import("../ui.js");
    expect(styleAnsi("\x1b[1m1. What each UI does well\x1b[22m")).toContain("\x1b[38;2;210;168;255m");
    expect(styleAnsi("- keep fixes")).toContain("\x1b[38;2;121;192;255m•");
    expect(styleAnsi("plain text")).toBe("plain text");
  });
});

describe("prompt ranking stopwords", () => {
  it("ignores filler words", async () => {
    const { rankTechniques } = await import("../prompts.js");
    const T = (name: string, useWhen: string) => ({ name, alias: null, description: "d", useWhen, example: "e", category: "c" });
    expect(rankTechniques([T("a", "and the"), T("b", "plan failure")], "and")).toHaveLength(2); // only stopwords → unranked full list
    expect(rankTechniques([T("a", "and the"), T("b", "plan failure")], "the plan").map((t) => t.name)).toEqual(["b"]);
  });
});

describe("plain-text structure", () => {
  it("turns underlined titles and dashed sections into headings, dims keys", async () => {
    const { fitAnsi, styleAnsi } = await import("../ui.js");
    const out = fitAnsi("PROMPT TECHNIQUE PREVIEW\n========\n\nTechnique: persona_simulation\n--- ORIGINAL QUERY ---\nRedesign it", 80).split("\n").map(styleAnsi);
    const plainOut = out.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
    expect(plainOut).not.toContain("========");
    expect(out[0]).toContain("\x1b[38;2;210;168;255m");
    expect(out.find((l) => l.includes("ORIGINAL QUERY"))).toContain("\x1b[38;2;210;168;255m");
    expect(out.find((l) => l.includes("Technique"))).toContain("\x1b[38;2;139;148;158mTechnique:");
  });
});

describe("group + row labels", () => {
  it("names image-only groups after their first call, previews JSON input", async () => {
    const { questionGroups, groupItems, inputPreview } = await import("../ui.js");
    expect(inputPreview('{"task":"Next polish pass","mode":"start"}')).toBe("Next polish pass");
    const items = groupItems([{ key: "a", type: "tool", via: "tachibot", source: "claude", depth: 0, ts: 20, status: "ok", title: "tachibot · planner_maker", input: '{"task":"Next polish pass"}' }] as never[]);
    expect(questionGroups(items, [{ ts: 10, text: "[Image #3]" }])[0].label).toBe("screenshot → planner_maker: Next polish pass");
  });
});

describe("memory front matter", () => {
  it("splits YAML front matter into properties", async () => {
    const { frontMatter } = await import("../ui.js");
    const r = frontMatter('---\nagent_id: "a-1"\ntask: "Monetization"\n---\n# Current Workspace\n');
    expect(r.props).toEqual([["agent_id", "a-1"], ["task", "Monetization"]]);
    expect(r.body).toBe("# Current Workspace\n");
    expect(frontMatter("# no front matter").props).toEqual([]);
  });
});

describe("dokoro reader", () => {
  it("splits dense enumerations and labels, shortens note names", async () => {
    const { readable, noteName } = await import("../ui.js");
    const dense = "DeepSeek analysis. Changes: (1) input handler per view, keeping dispatch order and adding help; (2) hint bar wraps at normal density, truncates at compact; (3) density toggle. Ranking: hint wrap High/Low; density High/Med. Risks: debounce swallowing fast keys.";
    const out = readable(dense);
    expect(out).toContain("\n1. input handler");
    expect(out).toContain("\n2. hint bar wraps");
    expect(out).toContain("**Ranking:**");
    expect(out).toContain("**Risks:**");
    expect(readable("short line (1) stays")).toBe("short line (1) stays");
    expect(noteName("dokoro/daily/2026-10-31-00h55m-saturday-plan-next-polish-pass.md")).toBe("plan-next-polish-pass · 10-31 00:55");
  });
});

describe("markdown reader", () => {
  it("styles headings, tasks, callouts, fences and tables", async () => {
    const { renderMarkdown, visible } = await import("../md.js");
    const md = "# Title\n## Part\n### Sub\n- [x] done\n- [ ] open\n> [!WARNING]\n> careful here\n```ts\nconst a = 1;\n```\n| a | b |\n|---|---|\n| 1 | 2 |";
    const out = renderMarkdown(md, 40).map(visible).map((l) => l.trimEnd());
    expect(out).toContain("Title");
    expect(out.some((l) => /^━+$/.test(l))).toBe(true);
    expect(out).toContain("▍ Part");
    expect(out).toContain("◆ Sub");
    expect(out).toContain("✓ done");
    expect(out).toContain("○ open");
    expect(out).toContain(" ⚠ WARNING");
    expect(out).toContain(" careful here");
    expect(out).toContain(" ts");
    expect(out).toContain(" const a = 1;");
    expect(out.some((l) => l.startsWith("┌") && l.endsWith("┐"))).toBe(true);
    expect(out).toContain("│ 1 │ 2 │");
  });
});

describe("link spans", () => {
  it("finds OSC 8 links by visible column", async () => {
    const { linkSpans } = await import("../ui.js");
    const { link } = await import("../md.js");
    const line = `\x1b[1mab\x1b[22m ${link("docs", "https://a.dev/x")} z`;
    expect(linkSpans(line)).toEqual([{ from: 3, to: 7, url: "https://a.dev/x" }]);
  });
});

describe("human time", () => {
  it("formats ISO timestamps with weekday, local time, part of day and age", async () => {
    const { humanTime } = await import("../ui.js");
    const iso = "2026-07-01T21:51:45.059Z";
    const out = humanTime(iso, Date.parse("2026-10-31T02:00:00Z"));
    expect(out).toMatch(/^(Wed|Thu) \d{1,2} Jul 2026 · \d{2}:\d{2} (☼ morning|☀ midday|◑ afternoon|☾ evening|✦ night) · 4 months ago$/);
    expect(humanTime("agent-260701215145")).toBe("agent-260701215145");
    expect(humanTime("2026-07-01", Date.parse("2026-07-03T00:00:00Z"))).toMatch(/Jul 2026 · 2 days ago/);
  });
});
