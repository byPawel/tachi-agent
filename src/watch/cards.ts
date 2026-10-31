/**
 * tachi-watch — one renderer per tachibot tool (pure). A call card shares one
 * header grammar (status · tool · pills); the body starts with a visual summary
 * shaped by the tool's output — Jev's probabilities as bars, a search's sources
 * as domain chips, a review's verdict as a badge — ABOVE the full output, which
 * is never dropped. Unknown output gets no summary (the markdown body stands).
 * Also: the council phase strip and the verdict's confidence meter.
 */
import stringWidth from "string-width";
import { chip, stepsLine } from "./components.js";

const SGR = (open: number, close: number) => (s: string) => `\x1b[${open}m${s}\x1b[${close}m`;
const bold = SGR(1, 22);
const dim = SGR(2, 22);
const green = SGR(32, 39);
const yellow = SGR(33, 39);
const cyan = SGR(36, 39);

/** A horizontal bar for p in 0..1. */
function bar(p: number, cells: number): string {
  const n = Math.max(0, Math.min(cells, Math.round(p * cells)));
  return `${green("█".repeat(n))}${dim("░".repeat(cells - n))}`;
}

function jevBars(output: string, width: number): string[] {
  let data: unknown;
  try {
    data = JSON.parse(output.slice(output.indexOf("{")));
  } catch {
    return [];
  }
  const answers = (data as { answers?: Record<string, Record<string, unknown>> })?.answers;
  if (!answers || typeof answers !== "object") return [];
  const out: string[] = [];
  for (const [name, a] of Object.entries(answers)) {
    if (typeof a?.noul === "number") {
      out.push(`${bold(name)}  ${bar(a.noul, 20)} ${a.noul.toFixed(2)}`);
      continue;
    }
    const probs = a?.probabilities;
    if (!probs || typeof probs !== "object") continue;
    // score answers carry a legend — a list, or an {"0":"low"} map — for their level keys
    const legendRaw = a.legend as string[] | Record<string, string> | undefined;
    const label = (k: string) => (Array.isArray(legendRaw) ? legendRaw[Number(k)] : legendRaw?.[k]) ?? k;
    const entries = (Array.isArray(probs)
      ? (probs as number[]).map((p, i) => [String(i), p] as const)
      : Object.entries(probs as Record<string, number>)).map(([k, p]) => [label(k), p] as const);
    const pick = typeof a.choice === "string" ? a.choice : entries.reduce((b, e) => (e[1] > b[1] ? e : b), entries[0])?.[0];
    const conf = typeof a.confidence === "number" ? a.confidence : undefined;
    out.push(`${bold(name)} ${cyan(`→ ${pick}`)}${conf !== undefined ? dim(`  confidence ${conf.toFixed(2)}`) : ""}${conf !== undefined && conf < 0.5 ? yellow("  low confidence") : ""}`);
    const labelW = Math.min(24, Math.max(...entries.map(([k]) => k.length)));
    const cells = Math.max(6, Math.min(24, width - labelW - 10));
    for (const [k, p] of entries) out.push(`  ${k.slice(0, labelW).padEnd(labelW)} ${bar(Number(p) || 0, cells)} ${(Number(p) || 0).toFixed(2)}`);
  }
  return out;
}

const URLS = /https?:\/\/([a-z0-9.-]+)/gi;
function sourceChips(output: string, width: number): string[] {
  const counts = new Map<string, number>();
  let total = 0;
  for (const m of output.matchAll(URLS)) {
    const host = m[1].replace(/^www\./, "");
    counts.set(host, (counts.get(host) ?? 0) + 1);
    total++;
  }
  if (!total) return [];
  const chips = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([h, n]) => chip(n > 1 ? `${h} ×${n}` : h, "#c9d1d9", "#1f2937"));
  const lines = [bold(`${total} sources`) + dim(` · ${counts.size} sites`)];
  let row = "";
  let used = 0;
  for (const [i, c] of chips.entries()) {
    const w = [...counts.keys()][i].length + 6;
    if (used && used + w > width) {
      lines.push(row);
      row = "";
      used = 0;
    }
    row += `${c} `;
    used += w;
  }
  if (row) lines.push(row);
  return lines;
}

const DEGRADED = /\[degraded: (\S+) unavailable — ([^;\]]+); answered by (\S+?)\]/;
function degraded(output: string): string[] {
  const m = DEGRADED.exec(output.slice(0, 400));
  return m ? [yellow(`↳ ${m[1]} → ${m[3]}`) + dim(`  (${m[2].trim()})`)] : [];
}

/** diff/security review: the badge and counts, then the issues that name a file:line. */
function reviewView(output: string, width: number): string[] {
  const head = mergeBadge(output);
  const issues: string[] = [];
  for (const m of output.matchAll(/([\w./-]+\.(?:ts|tsx|js|py|go|rs|java|rb|md|json|yaml|yml)):(\d+)\b[^\n]{0,4}?[—:-]?\s*([^\n]{0,90})/g)) {
    const sev = /critical|high/i.test(m[0]) ? "\x1b[38;2;255;123;114m●\x1b[39m" : /major|medium/i.test(m[0]) ? yellow("●") : dim("●");
    const text = m[3].replace(/\*\*/g, "").replace(/^[\s—:–-]+/, "").trim();
    const line = `${sev} ${cyan(`${m[1].split("/").pop()}:${m[2]}`)}  ${dim(text)}`;
    if (!issues.some((x) => x.includes(`${m[1].split("/").pop()}:${m[2]}`))) issues.push(line);
    if (issues.length >= 6) break;
  }
  if (!head.length && !issues.length) return [];
  return [...head, ...(issues.length ? ["", ...issues.map((l) => (l.length > width + 40 ? l : l))] : [])];
}

function mergeBadge(output: string): string[] {
  const not = /NOT\s+MERGEABLE/i.test(output);
  const yes = !not && /\bMERGEABLE\b/i.test(output);
  const sev = (w: string) => (output.match(new RegExp(`\\b${w}\\b`, "gi")) ?? []).length;
  const counts = [
    ["critical", sev("critical"), "#ff7b72", "#3a1418"],
    ["major", sev("major"), "#e3b341", "#2a1f0a"],
    ["minor", sev("minor"), "#8b949e", "#1f2937"],
  ] as const;
  if (!not && !yes && counts.every(([, n]) => !n)) return [];
  const badge = not ? chip("NOT MERGEABLE", "#ff7b72", "#3a1418") : yes ? chip("MERGEABLE", "#7ee787", "#12261a") : "";
  return [[badge, ...counts.filter(([, n]) => n).map(([w, n, fg, bg]) => chip(`${n} ${w}`, fg, bg))].filter(Boolean).join(" ")];
}

function checklist(output: string, width: number): string[] {
  const done = (output.match(/^\s*[-*] \[[xX]\]/gm) ?? []).length;
  const open = (output.match(/^\s*[-*] \[ \]/gm) ?? []).length;
  if (!done && !open) return [];
  const total = done + open;
  return [`${bold(`${done} / ${total} done`)}  ${bar(done / total, Math.max(6, Math.min(30, width - 20)))}`];
}

/** debug_triage: ranked hypotheses as likelihood bars, the top one's cheapest check under them. */
function ranked(output: string, width = 60): string[] {
  const rows: Array<{ n: number; what: string; pct: number }> = [];
  for (const m of output.matchAll(/^\s*(\d+)[.)]\s+(.{3,90}?)\s*[(\[—-]*\s*(\d{1,3})\s*%[)\]]?/gm)) {
    rows.push({ n: Number(m[1]), what: m[2].replace(/[\s·—:(-]+$/, "").replace(/\*\*/g, ""), pct: Number(m[3]) });
    if (rows.length >= 5) break;
  }
  if (!rows.length) return [];
  const barW = Math.max(6, Math.min(20, Math.floor(width / 4)));
  const textW = Math.max(10, width - barW - 10);
  const out = [bold(`HYPOTHESES  ${rows.length}`)];
  for (const r of rows) {
    const top = r.n === rows[0].n;
    const what = r.what.length > textW ? `${r.what.slice(0, textW - 1)}…` : r.what.padEnd(textW);
    out.push(`${top ? yellow(bold(String(r.n))) : dim(String(r.n))} ${top ? what : dim(what)} ${top ? yellow(bar(r.pct / 100, barW)) : dim(bar(r.pct / 100, barW))} ${String(r.pct).padStart(3)}%`);
  }
  const check = /(?:cheapest|discriminating)[^\n]*?(?:check|evidence)[^\n]*?[:—-]\s*\n?\s*(?:[-*\d.)\s]*)([^\n]{6,160})/i.exec(output);
  if (check) out.push("", `${dim("check first")}  ${cyan(check[1].replace(/\*\*/g, "").trim())}`);
  return out;
}

/** jury: the verdict's headline, the panel as rows (✓ answered · ✗ dropped), a confidence meter when stated. */
function juryView(output: string, width: number): string[] {
  const live = [...output.matchAll(/^- ([A-Z]): (.+)$/gm)].map((m) => [m[1], m[2].replace(/\s*\(.*\)$/, "")] as const);
  const dropped = [...output.matchAll(/^- (.+?) — DROPPED/gm)].map((m) => m[1].replace(/\s*\(.*\)$/, ""));
  if (!live.length && !dropped.length) return [];
  const out: string[] = [];
  const verdict = /^VERDICT\s*\n+([^\n]+)/m.exec(output)?.[1]?.replace(/\*\*/g, "").trim();
  if (verdict) out.push(bold(verdict.length > width ? `${verdict.slice(0, width - 1)}…` : verdict), "");
  out.push(bold(`PANEL  ${live.length}/${live.length + dropped.length} answered`));
  for (const [letter, name] of live) out.push(`${green("✓")} ${dim(letter)}  ${name}`);
  for (const name of dropped) out.push(`${"\x1b[38;2;255;123;114m✗\x1b[39m"} ${dim("—")}  ${dim(`${name} · dropped (provider error or quota)`)}`);
  return out;
}


/** A markdown table's first numeric column as horizontal bars (usage_stats). */
function tableBars(output: string, width: number): string[] {
  const rows = output.split("\n").filter((l) => /^\s*\|.*\|\s*$/.test(l) && !/^\s*\|?\s*:?-{2,}/.test(l));
  if (rows.length < 3) return [];
  const cells = rows.map((r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
  const col = cells[1].findIndex((c, i) => i > 0 && /^[$]?[\d,.]+[%s]?$/.test(c));
  if (col < 0) return [];
  const data = cells.slice(1).map((r) => [r[0], Number(r[col].replace(/[$,%s]/g, "")) || 0] as const).slice(0, 10);
  const max = Math.max(...data.map(([, v]) => v), 1);
  const labelW = Math.min(16, Math.max(...data.map(([k]) => k.length)));
  const cells2 = Math.max(6, Math.min(30, width - labelW - 12));
  return [dim(cells[0][col]), ...data.map(([k, v]) => `${k.slice(0, labelW).padEnd(labelW)} ${bar(v / max, cells2)} ${cells.find((r) => r[0] === k)?.[col] ?? v}`)];
}

/** The visual summary for one call's output; [] when the tool has no renderer or the output doesn't fit it. */
// --- card renderer registry ------------------------------------------------------
// A tool's look in the card is a registered renderer, so a new tool view is one
// registerCard() call — no edits to ui.tsx. Every matching renderer contributes.

export interface CardContext {
  /** the tool name without the "tachibot · " prefix */
  tool: string;
  /** the call's output as plain text */
  output: string;
  width: number;
}

export interface CardRenderer {
  name: string;
  match: RegExp;
  /** lines above INPUT — the call's headline view (the planner's step block) */
  top?: (ctx: CardContext) => string[];
  /** a graphic above the output text (bars, chips, badges) */
  summary?: (ctx: CardContext) => string[];
  /** replaces the default output text; undefined keeps the default */
  output?: (ctx: CardContext) => string[] | undefined;
}

const RENDERERS: CardRenderer[] = [];

/** Register a tool view. Later registrations add to earlier ones; nothing is replaced. */
export function registerCard(r: CardRenderer): void {
  RENDERERS.push(r);
}

export function renderersFor(tool: string): CardRenderer[] {
  const t = tool.replace(/^tachibot · /, "");
  return RENDERERS.filter((r) => r.match.test(t));
}

/** The summary graphics for a call: the fallback banner, then every matching renderer's summary. */
export function toolCard(tool: string, output: string, width: number): string[] {
  const ctx = { tool: tool.replace(/^tachibot · /, ""), output, width };
  return [...degraded(output), ...renderersFor(tool).flatMap((r) => r.summary?.(ctx) ?? [])];
}

registerCard({ name: "jev", match: /^jev_decide$/, summary: (c) => jevBars(c.output, c.width) });
registerCard({ name: "sources", match: /search|perplexity_ask|perplexity_reason/, summary: (c) => sourceChips(c.output, c.width) });
registerCard({ name: "verdict", match: /^(diff_review|security_review|openai_code_review)$/, summary: (c) => reviewView(c.output, c.width) });
registerCard({ name: "checklist", match: /planner|plan_critique/, summary: (c) => checklist(c.output, c.width) });
registerCard({ name: "triage", match: /^debug_triage$/, summary: (c) => ranked(c.output, c.width) });
registerCard({ name: "jury", match: /^jury$/, summary: (c) => juryView(c.output, c.width) });
registerCard({ name: "usage", match: /^usage_stats$/, summary: (c) => tableBars(c.output, c.width) });

// --- council --------------------------------------------------------------------

const PHASES: Array<{ label: string; tools: RegExp }> = [
  { label: "Research", tools: /^(grok_search|grok_search_lite|perplexity_ask|perplexity_reason|gemini_search|openai_search)$/ },
  { label: "Evidence", tools: /^jev_decide$/ },
  { label: "Debate", tools: /^(grok_reason|kimi_thinking|openai_reason|deepseek_reason|qwen_reason)$/ },
  { label: "Reasoning", tools: /^nextThought$/ },
  { label: "Resolution", tools: /^(gemini_judge)$/ },
];
const COUNCIL_WINDOW_MS = 15 * 60_000;

/** The council phases that ran in the 15 min before (and including) the latest resolver call. */
export function councilPhases(calls: Array<{ tool: string; status: string; ts: number }>): Array<{ label: string; status: string }> {
  const name = (c: { tool: string }) => c.tool.replace(/^tachibot · /, "");
  const end = [...calls].reverse().find((c) => name(c) === "gemini_judge");
  if (!end) return [];
  const window = calls.filter((c) => c.ts <= end.ts && end.ts - c.ts <= COUNCIL_WINDOW_MS);
  const phases = PHASES.map((p) => {
    const hits = window.filter((c) => p.tools.test(name(c)));
    if (!hits.length) return undefined;
    const status = hits.some((c) => c.status === "running") ? "running"
      : hits.some((c) => c.status === "error") ? "error"
      : hits.some((c) => c.status === "fallback") ? "fallback" : "ok";
    return { label: p.label, status };
  }).filter((p): p is { label: string; status: string } => !!p);
  return phases.length >= 3 ? phases : [];
}

/** "Confidence: Medium" → ■■□ MEDIUM */
export function confidenceMeter(text: string): string | undefined {
  const m = /confidence\W{0,4}(high|medium|low)\b/i.exec(text);
  if (!m) return undefined;
  const level = m[1].toLowerCase();
  const n = level === "high" ? 3 : level === "medium" ? 2 : 1;
  return `${"■".repeat(n)}${"□".repeat(3 - n)} ${level.toUpperCase()}`;
}

export { stepsLine };

// --- council panel (the Council artboard) ----------------------------------------

export interface CouncilCall {
  tool: string;
  status: string;
  ts: number;
  ms?: number;
  input?: string;
  output?: string;
  cite?: string;
}

// terminal columns, not string length — emoji are 2 wide and would push box borders out
const visibleLen = (s: string) => stringWidth(s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x07]*\x07/g, ""));
const fg = (hex: string) => (s: string) => `\x1b[38;2;${parseInt(hex.slice(1, 3), 16)};${parseInt(hex.slice(3, 5), 16)};${parseInt(hex.slice(5, 7), 16)}m${s}\x1b[39m`;
const C = { ok: fg("#7ee787"), warn: fg("#e3b341"), err: fg("#ff7b72"), blue: fg("#79c0ff"), muted: fg("#8b949e"), white: fg("#f0f6fc"), purple: fg("#d2a8ff") };

/** A rounded box around lines, `w` columns wide, title in the top border. */
export function boxLines(title: string, body: string[], w: number, color: (s: string) => string): string[] {
  w = Math.max(w, visibleLen(title) + 6, 12);
  const inner = Math.max(4, w - 4);
  const top = `╭─ ${title} ${"─".repeat(Math.max(0, w - visibleLen(title) - 5))}╮`;
  const rows = body.flatMap((l) => wrapPlain(l, inner)).map((l) => `${color("│")} ${l}${" ".repeat(Math.max(0, inner - visibleLen(l)))} ${color("│")}`);
  return [color(top.replace(title, "\x00")).replace("\x00", bold(title)), ...rows, color(`╰${"─".repeat(w - 2)}╯`)];
}

/** Plain-ish wrap that keeps SGR codes (cuts only at spaces of visible text). */
function wrapPlain(line: string, w: number): string[] {
  if (visibleLen(line) <= w) return [line];
  const out: string[] = [];
  let cur = "";
  for (const word of line.split(" ")) {
    if (cur && visibleLen(cur) + 1 + visibleLen(word) > w) {
      out.push(cur);
      cur = word;
    } else cur = cur ? `${cur} ${word}` : word;
  }
  if (cur) out.push(cur);
  return out;
}

/** Side-by-side columns of equal width (each a list of lines), joined with a gap. */
function columns(cols: string[][], w: number, gap = 1): string[] {
  const n = cols.length;
  const cw = Math.floor((w - gap * (n - 1)) / n);
  const h = Math.max(...cols.map((c) => c.length));
  const out: string[] = [];
  for (let r = 0; r < h; r++) out.push(cols.map((c) => { const l = c[r] ?? ""; return l + " ".repeat(Math.max(0, cw - visibleLen(l))); }).join(" ".repeat(gap)));
  return out;
}

/** The first real sentence of a model answer: skip banners, headings, chips, blank lines. */
export function firstPoint(text: string, max = 160): string {
  // whole paragraphs, not wrapped lines: tachibot hard-wraps its answers at ~80 columns
  const paras = text.replace(/\x1b\[[0-9;]*m/g, "").replace(/\[(truncated|degraded)[^\]]*\]/g, "")
    .split(/\n\s*\n/)
    .flatMap((p) => {
      const lines = p.split("\n");
      const out: string[] = [];
      for (const l of lines) {
        const isItem = /^\s*([-*•◦]|\d+[.)])\s/.test(l) || /^\s*#/.test(l);
        if (out.length && !isItem && l.trim() && !/[─━]{3}|^\p{Extended_Pictographic}/u.test(l.trim())) out[out.length - 1] += ` ${l.trim()}`;
        else out.push(l);
      }
      return out;
    });
  for (const raw of paras) {
    const l = raw.replace(/^[\s>*•\-–#\d.)]+/, "").replace(/\*\*/g, "").trim();
    if (l.length < 25 || /^\[degraded|^(grok|kimi|openai|gemini|perplexity)\b|───|✅|^[A-Z0-9 &/]{6,}$|^\p{Extended_Pictographic}/u.test(l)) continue;
    if (l.length <= max) return l;
    // end on a sentence if one fits, else on a word — never mid-word
    const cut = l.slice(0, max);
    const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "));
    return end > max * 0.4 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(" "))}…`;
  }
  return "";
}

const ROLE: Record<string, { label: string; color: (s: string) => string }> = {
  grok_reason: { label: "FOR", color: C.ok },
  kimi_thinking: { label: "AGAINST", color: C.err },
  openai_reason: { label: "SYNTHESIS", color: C.blue },
  deepseek_reason: { label: "CRITIC", color: C.err },
  qwen_reason: { label: "SYNTHESIS", color: C.blue },
};

/** The Council artboard for the resolver call: question, phases, debate roles, calibration, verdict. */
export function councilPanel(calls: CouncilCall[], judge: CouncilCall, width: number): string[] {
  const name = (c: CouncilCall) => c.tool.replace(/^tachibot · /, "");
  const window = calls.filter((c) => c.ts <= judge.ts && judge.ts - c.ts <= COUNCIL_WINDOW_MS);
  const phases = councilPhases(window.map((c) => ({ tool: c.tool, status: c.status, ts: c.ts })));
  if (!phases.length) return [];
  const w = Math.max(40, width);
  const out: string[] = [];
  const total = Math.round((judge.ts + (judge.ms ?? 0) - Math.min(...window.map((c) => c.ts))) / 1000);
  const falls = window.filter((c) => c.status === "fallback" || /\[degraded:/.test(c.output ?? "")).length;
  const cut = window.filter((c) => /\[truncated/.test(c.output ?? "")).length;
  out.push(`${C.blue(bold("COUNCIL"))} ${C.muted(`· ${window.length} calls · ${Math.floor(total / 60)}m ${total % 60}s`)}  ${falls ? chip(`${falls} fallback`, "#e3b341", "#2a1f0a") : ""} ${cut ? chip(`${cut} truncated`, "#ff7b72", "#3a1418") : ""}`);
  const q = (judge.input ?? "").replace(/^question:\s*/m, "").split("\n")[0];
  if (q) out.push(...wrapPlain(bold(C.white(q)), w));
  out.push("");

  // phase boxes
  const phaseBox = (p: { label: string; status: string }, i: number) => {
    const color = p.status === "ok" ? C.ok : p.status === "running" ? C.blue : p.status === "error" ? C.err : C.warn;
    const mark = p.status === "ok" ? "✓" : p.status === "running" ? "⠼" : p.status === "error" ? "✗" : "↳";
    const n = window.filter((c) => PHASES.find((ph) => ph.label === p.label)!.tools.test(name(c))).length;
    return (bw: number) => boxLines(`${"①②③④⑤"[i]} ${p.label} ${mark}`, [C.muted(`${n} call${n === 1 ? "" : "s"}`)], bw, color);
  };
  const perRow = w >= 100 ? phases.length : w >= 60 ? 3 : 2;
  const cw = Math.floor((w - (perRow - 1)) / perRow);
  for (let i = 0; i < phases.length; i += perRow) {
    out.push(...columns(phases.slice(i, i + perRow).map((p, k) => phaseBox(p, i + k)(cw)), w));
  }
  out.push("");

  // debate role cards
  const debate = window.filter((c) => ROLE[name(c)]);
  if (debate.length) {
    const cards = debate.slice(0, 3).map((c) => {
      const role = ROLE[name(c)];
      const tags = [
        c.ms !== undefined ? C.muted(`${(c.ms / 1000).toFixed(1)}s`) : "",
        /\[degraded:/.test(c.output ?? "") || c.status === "fallback" ? C.warn(`↳ ${/answered by (\S+?)\]/.exec(c.output ?? "")?.[1] ?? c.cite ?? "fallback"}`) : "",
        /\[truncated/.test(c.output ?? "") ? C.err("truncated") : "",
      ].filter(Boolean).join("  ");
      return (bw: number) => boxLines(`${role.label} · ${name(c).split("_")[0]}`, [tags, firstPoint(c.output ?? "")], bw, role.color);
    });
    const dw = w >= 90 ? Math.floor((w - (cards.length - 1)) / cards.length) : w;
    out.push(...(w >= 90 ? columns(cards.map((b) => b(dw)), w) : cards.flatMap((b) => b(w))));
    out.push("");
  }

  // calibration (Jev)
  const jev = [...window].reverse().find((c) => name(c) === "jev_decide");
  if (jev?.output) {
    const bars = toolCard("jev_decide", jev.output, Math.min(w, 60) - 4);
    if (bars.length) {
      out.push(...boxLines("CALIBRATION · Jev", [...bars, C.muted("Jev sees only the state it is given — weigh it as a cross-check, not a vote")], Math.min(w, 70), C.blue));
      out.push("");
    }
  }

  // verdict
  const text = (judge.output ?? "").replace(/\x1b\[[0-9;]*m/g, "");
  const conf = confidenceMeter(text);
  // the paragraph under a Recommendation / Verdict HEADING (not a sentence that mentions the word)
  const recPara = /^\s*(?:#{1,4}\s*|\d+\.\s*|\*\*|[•\-]\s*)?[^\n]{0,24}\b(?:recommendation|verdict)\b[^\n]{0,24}$\n+((?:[^\n]+\n?)+?)(?:\n\s*\n|$)/im.exec(text)?.[1];
  const rec = recPara ? firstPoint(recPara.replace(/\n\s*/g, " "), 240) || recPara.replace(/\s+/g, " ").slice(0, 240) : firstPoint(text, 240);
  // steps: the items under an "implementation steps" / "first actions" heading only
  const stepsBlock = /^[^\n]{0,30}\b(?:implementation steps|first (?:3|three) actions|next steps|actions)\b[^\n]*\n((?:\s*(?:[-*•]|\d[.)]|action \d)[^\n]*\n?){1,6})/im.exec(text)?.[1] ?? "";
  const steps = stepsBlock.replace(/\n(?!\s*(?:[-*•]|\d[.)]|action \d))\s*/gi, " ").split("\n").map((l) => l.replace(/^\s*(?:[-*•]\s*)?(?:action\s*)?\d?[.):]?\s*/i, "").replace(/\*\*/g, "").trim()).filter((l) => l.length > 6).slice(0, 3).map((l, i) => `${C.blue(String(i + 1))} ${l}`);
  const verdict = [bold(C.white(rec.replace(/\*\*/g, ""))), ...(steps.length ? ["", ...steps] : [])];
  out.push(...boxLines(`VERDICT${conf ? `  ${conf}` : ""}`, verdict, w, C.ok));
  return out;
}

// --- planner_maker: a step tracker instead of the raw coordinator text ---------
const rgbFg = (r: number, g: number, b: number) => (s: string) => `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`;
const P_GREEN = rgbFg(126, 231, 135);
const P_AMBER = rgbFg(227, 179, 65);
const P_PURPLE = rgbFg(210, 168, 255);
const P_BLUE = rgbFg(121, 192, 255);
const P_MUTED = rgbFg(139, 148, 158);
const P_TEXT = rgbFg(201, 209, 217);
const P_CHIP = (s: string) => `\x1b[48;2;31;41;55m${s}\x1b[49m`;
const P_LINK = (text: string, url: string) => `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;

export interface PlannerStep { step: number; total: number; phase: string; why: string; next?: { tool: string; desc: string }; plan?: string; handoff?: { step: number; key: string }; note?: string; rest: string }

/** Parse planner_maker's coordinator output (visible text). Undefined when it isn't one. */
export function parsePlanner(text: string): PlannerStep | undefined {
  const head = /Step\s+(\d+)\s*\/\s*(\d+)\s*·\s*([^\n]+)/.exec(text);
  if (!head) return undefined;
  const why = /Why This Step\s*\n+([\s\S]*?)(?=\n\s*\n\s*(?:Next\b|📝|📄|▶|IMPORTANT)|\n(?:Next|📝|📄|▶)|$)/.exec(text)?.[1]?.trim() ?? "";
  const next = /Next\s*→\s*([a-z_]+)\s*·\s*([^\n]+)/.exec(text);
  const plan = /Live plan:\s*(\S+\.md)/.exec(text)?.[1];
  const exec = /Execute\s+\S+,\s*then:\s*planner_maker\(\{[^\n]*?step:\s*(\d+)[^\n]*?\.\.\.prior,\s*([a-z_]+):/.exec(text);
  const note = /IMPORTANT:\s*([^\n]+)/.exec(text)?.[1];
  const rest = text
    .split("\n")
    .filter((l) => !/planner_maker\s*$|Step\s+\d+\s*\/\s*\d+|Why This Step|^\s*Next\s*→|Live plan:|Execute\s+\S+,\s*then:|IMPORTANT:|📝/.test(l))
    .join("\n")
    .replace(why, "")
    .trim();
  return {
    step: Number(head[1]), total: Number(head[2]), phase: head[3].trim(), why,
    next: next ? { tool: next[1], desc: next[2].trim() } : undefined,
    plan, handoff: exec ? { step: Number(exec[1]), key: exec[2] } : undefined, note, rest,
  };
}

export interface PlannerStepInfo { phase: string; action?: string; tool?: string }

const STEP_LABEL: Record<string, string> = {
  grok_search: "search", perplexity_ask: "search", openai_search: "search", gemini_search: "search",
  qwen_coder: "code", deepseek_reason: "code", qwen_algo: "code", kimi_thinking: "steps", kimi_decompose: "split",
  openai_reason: "review", gemini_analyze_text: "judge", gemini_judge: "judge", qwen_reason: "draft", grok_reason: "reason",
};
/** A short name for a planner step under its segment: from the tool it ran, else its phase. */
export function stepLabel(info: PlannerStepInfo | undefined, n: number, total: number): string {
  if (n === total) return "final";
  if (info?.tool && STEP_LABEL[info.tool]) return STEP_LABEL[info.tool];
  return info?.phase.toLowerCase().split(/\s+/)[0] ?? String(n);
}

/** The planner card: progress, every step by name (✓ done · ● now · ○ next), why, next/handoff/plan, the note. */
export function plannerCard(p: PlannerStep, width: number, steps: Map<number, PlannerStepInfo> = new Map()): string[] {
  const out: string[] = [];
  const vis = (s: string) => stringWidth(s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x07]*\x07/g, ""));
  const bgRow = (s: string, bg: [number, number, number]) => `\x1b[48;2;${bg[0]};${bg[1]};${bg[2]}m${s}${" ".repeat(Math.max(0, width - vis(s)))}\x1b[49m`;
  // a thin progress bar
  const seg = Math.max(1, Math.floor((width - (p.total - 1)) / p.total));
  const color = (n: number) => (n < p.step ? [126, 231, 135] : n === p.step ? [227, 179, 65] : [33, 38, 45]);
  out.push(Array.from({ length: p.total }, (_, i) => { const [r, g, b] = color(i + 1); return `\x1b[38;2;${r};${g};${b}m${"▀".repeat(seg)}\x1b[39m`; }).join(" "));
  // each segment's name under it (done green, now amber, later muted)
  const labels = Array.from({ length: p.total }, (_, i) => stepLabel(i + 1 === p.step ? { phase: p.phase, tool: steps.get(i + 1)?.tool } : steps.get(i + 1), i + 1, p.total));
  // the names row only when every name fits whole under its segment; the step list below always names them
  if (labels.every((l) => l.length <= seg)) {
    out.push(Array.from({ length: p.total }, (_, i) => {
      const n = i + 1;
      const cell = labels[i].padEnd(seg);
      return n < p.step ? P_GREEN(cell) : n === p.step ? `\x1b[1m${P_AMBER(cell)}\x1b[22m` : P_MUTED(cell);
    }).join(" "));
  }
  out.push("");
  out.push(`\x1b[1m${P_TEXT(`Step ${p.step} of ${p.total}`)}\x1b[22m ${P_PURPLE(`· ${p.phase}`)}`);
  out.push("");
  // every step by name, one or two columns
  const cols = width >= 60 ? 2 : 1;
  const colW = Math.floor((width - (cols - 1) * 2) / cols);
  const entry = (n: number) => {
    const info = n === p.step ? { phase: p.phase, action: steps.get(n)?.action } : steps.get(n);
    const mark = n < p.step ? P_GREEN("✓") : n === p.step ? P_AMBER("●") : P_MUTED("○");
    const name = info ? `${info.phase}${info.action ? ` · ${info.action}` : ""}` : "";
    const num = String(n).padStart(2);
    const room = colW - 5;
    const label = name.length > room ? name.slice(0, room - 1) + "…" : name;
    const styled = n < p.step ? P_TEXT(label) : n === p.step ? `\x1b[1m${P_AMBER(label)}\x1b[22m` : P_MUTED(label || "—");
    const cell = `${mark} ${P_MUTED(num)} ${styled}`;
    return cell + " ".repeat(Math.max(0, colW - vis(cell)));
  };
  const rows = Math.ceil(p.total / cols);
  for (let r = 0; r < rows; r++) out.push(Array.from({ length: cols }, (_, c) => (r + c * rows < p.total ? entry(r + c * rows + 1) : "")).join("  ").trimEnd());
  out.push("");
  if (p.why) {
    out.push(P_MUTED("WHY THIS STEP"));
    for (const l of wrapPlain(p.why.replace(/\s+/g, " "), width - 2)) out.push(bgRow(` ${P_TEXT(l)}`, [22, 27, 34]));
    out.push("");
  }
  const label = (s: string) => P_MUTED(s.padEnd(9));
  if (p.next) {
    const pill = P_CHIP(`\x1b[1m${P_BLUE(` → ${p.next.tool} `)}\x1b[22m`);
    const one = `${label("NEXT")}${pill}  ${P_MUTED(p.next.desc)}`;
    if (vis(one) <= width) out.push(one);
    else {
      // too long for one row: the description wraps under the pill, never cut
      out.push(`${label("NEXT")}${pill}`);
      for (const l of wrapPlain(p.next.desc, width - 9)) out.push(`${" ".repeat(9)}${P_MUTED(l)}`);
    }
  }
  if (p.handoff) out.push(`${label("HANDOFF")}${P_MUTED(`full output → step ${p.handoff.step} as `)}${P_CHIP(P_AMBER(` ${p.handoff.key} `))}`);
  if (p.plan) {
    const name = p.plan.split("/").pop()!.replace(/\.md$/, "").replace(/^\d{4}-\d{2}-\d{2}-\d{2}h\d{2}m-(?:[a-z]+day-)?/, "");
    // a long plan name wraps instead of being cut
    wrapPlain(name, width - 11).forEach((l, i) => out.push(`${i ? " ".repeat(9) : label("PLAN")}${P_LINK(`\x1b[4m${P_BLUE(l)}\x1b[24m`, `file://${p.plan}`)}${i === 0 ? ` ${P_BLUE("↗")}` : ""}`));
  }
  if (p.note) {
    out.push("");
    wrapPlain(p.note, width - 4).forEach((l, i) => out.push(bgRow(` ${i ? "  " : `\x1b[1m${P_AMBER("!")}\x1b[22m `}${rgbFg(230, 211, 163)(l)}`, [28, 26, 16])));
  }
  return out;
}

/** planner_maker steps seen this session (step → phase/tool), set by the UI as calls arrive */
let plannerSteps = new Map<number, PlannerStepInfo>();
export function setPlannerSteps(m: Map<number, PlannerStepInfo>): void {
  plannerSteps = m;
}

registerCard({
  name: "planner",
  match: /^planner_maker$/,
  top: (c) => {
    const p = parsePlanner(c.output);
    return p ? [...plannerCard(p, c.width, plannerSteps), ""] : [];
  },
  output: (c) => {
    const p = parsePlanner(c.output);
    if (!p) return undefined;
    return p.rest ? undefined : ["\x1b[2m(the step block above is the whole output)\x1b[22m"];
  },
});
