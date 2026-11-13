import { spawn } from "node:child_process";
import fs from "node:fs";
import { homedir } from "node:os";
/**
 * tachi-watch pane — Ink (React for the terminal). Shows ONLY tachibot calls:
 * a one-line row per call, and the selected call opened in full — every input
 * argument, the whole output (scrollable), the model calls it made, and what
 * the second brain said about it (checked against project memory, live, after
 * every call). Claude collapses tool output; this pane is where you read it.
 *
 * Keys: ↑/↓ select call · PgUp/PgDn (or ctrl+u/ctrl+d) scroll the open call ·
 * End follow newest · type + Enter = ask about the open call (or /review,
 * /brain codex, /send text) · with a proposal and empty input: s/e/c ·
 * ctrl+c quit.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Box, Text, measureElement, render, useApp, useInput, useStdout, type DOMElement, type Key } from "ink";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import { CardHeader, FollowUps, Shimmer, Spinner, TabBar, Tag, tabSpans, THEME, gauge, shortModel, sparkline, stepsLine, toolTimeoutMs, useFrame, type View } from "./components.js";
import { confidenceMeter, councilPanel, councilPhases, parsePlanner, renderersFor, setPlannerSteps, setThoughtChain, toolCard, type PlannerStepInfo } from "./cards.js";
import { rankTechniques, type Technique } from "./prompts.js";
import { linkifyAnsi, renderMarkdown, stripControls } from "./md.js";
import { supportsTruecolor, to256 } from "./terminal.js";
import type { Card } from "./store.js";
import type { WatchController, WatchState } from "./watch.js";

function cardColor(status: Card["status"]): string {
  return status === "error" ? "#ff7b72" : status === "fallback" || status === "running" ? "#e3b341" : "#7ee787";
}

/** The selected row's background — the whole row, not just its text. */
const OPEN_BG = "#161b22"; // the open question's calls: a tinted card in the list
const SELECTED_BG = "#33415c";

const ICON: Record<Card["status"], { icon: string; color: string }> = {
  running: { icon: "◌", color: "#e3b341" },
  ok: { icon: "✓", color: "#7ee787" },
  error: { icon: "✗", color: "#ff7b72" },
  fallback: { icon: "↳", color: "#e3b341" },
  info: { icon: "·", color: "#8b949e" },
};

function time(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/**
 * Hard-wrap to `width` terminal COLUMNS (emoji and CJK are 2 wide) so every
 * rendered row is exactly one line — counting string length instead made rows
 * overflow, Ink re-wrapped them, and scrolling/selection drifted.
 */
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const raw of text.replace(/\t/g, "  ").split("\n")) {
    const line = raw.trimEnd();
    if (!line) out.push("");
    else out.push(...wrapAnsi(line, Math.max(4, width), { hard: true }).split("\n"));
  }
  return out;
}

/** A gap this long between two calls starts a new time group in the list. */
export const GROUP_GAP_MS = 5 * 60_000;

/** Index → divider label ("23:41") for each item that starts a new time group. */
export function timeGroups(items: Item[]): Map<number, string> {
  const out = new Map<number, string>();
  let prev: number | undefined;
  items.forEach((it, i) => {
    const ts = (it.call ?? it.loose)!.ts;
    if (prev === undefined || ts - prev > GROUP_GAP_MS) out.set(i, new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    prev = ts;
  });
  return out;
}

export interface QuestionGroup {
  /** the prompt's ts ("" for calls before the first prompt seen) */
  key: string;
  label: string;
  start: number;
  end: number;
}

/** Text the harness injects as a "user" turn — never a question of yours, so never a group. */
const SYSTEM_PROMPT = /^(A session-scoped Stop hook|This session is being continued|The summarized conversation|Stop hook feedback|\[SYSTEM NOTIFICATION|Caveat:|<local-command|<task-notification)/;

/**
 * Your prompt as a group label: image tags, pasted blocks and system tags removed; a skill
 * run ("Base directory for this skill: …/skills/council …ARGUMENTS: x") becomes "/council x".
 * Returns undefined for harness-injected turns, which start no group.
 */
export function cleanPrompt(text: string): string | undefined {
  const raw = text.trim();
  // harness text can open with a lone tag (<artifact-content-…/>) before the system sentence
  if (SYSTEM_PROMPT.test(raw.replace(/^(?:<[a-z][\w-]*(?:\s[^>]*)?\/?>\s*)+/, ""))) return undefined;
  // a skill / slash command expansion (the watcher keeps prompts flattened and clipped)
  const skill = /Base directory for this skill: \S*\/([\w:-]+)/.exec(raw) ?? /^`?(?:\/)([\w:-]+)`? was invoked/.exec(raw) ?? /<command-name>\/?([\w:-]+)<\/command-name>/.exec(raw);
  if (skill) {
    const args = /ARGUMENTS:\s*([\s\S]*)$/.exec(raw)?.[1] ?? /<command-args>([\s\S]*?)<\/command-args>/.exec(raw)?.[1] ?? /The brief:\s*([\s\S]*)$/.exec(raw)?.[1] ?? "";
    return `/${skill[1]} ${args ? cleanPrompt(args) ?? "" : ""}`.trim().slice(0, 60);
  }
  const t = raw
    .replace(/<pasted_content[\s\S]*?<\/pasted_content[^>]*>/g, " ")
    .replace(/<([a-z-]+)[^>]*>[\s\S]*?<\/\1>/g, " ")
    .replace(/<[a-z][\w-]*(?:\s[^>]*)?\/?>/g, " ") // lone tags (<artifact-content-authored-by-others/>)
    .replace(/\[Image[^\]]*\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (t || "screenshot").slice(0, 60);
}

/** Consecutive items under the same prompt (the latest one at or before each item) form a group. */
export function questionGroups(items: Item[], prompts: Array<{ ts: number; text: string }>, labels: Record<string, string> = {}): QuestionGroup[] {
  const ps = prompts
    .map((p) => ({ ...p, label: cleanPrompt(p.text) }))
    .filter((p): p is { ts: number; text: string; label: string } => !!p.label)
    .sort((a, b) => a.ts - b.ts);
  const out: QuestionGroup[] = [];
  let p = -1;
  items.forEach((it, i) => {
    const ts = (it.call ?? it.loose)!.ts;
    while (p + 1 < ps.length && ps[p + 1].ts <= ts) p++;
    const key = p >= 0 ? String(ps[p].ts) : "";
    const last = out[out.length - 1];
    if (last && last.key === key) last.end = i;
    else out.push({ key, label: labels[key] ?? (p >= 0 ? ps[p].label : "before this session"), start: i, end: i });
  });
  // an image-only prompt says nothing — name the group after the first call it led to
  for (const g of out) {
    if (labels[g.key] || g.label !== "screenshot") continue;
    const first = items.slice(g.start, g.end + 1).find((it) => it.call)?.call;
    if (first) g.label = `screenshot → ${first.title.replace(/^tachibot · /, "")}: ${inputPreview(first.input)}`.slice(0, 70);
  }
  return out;
}

/** A call's input as a one-line preview: JSON args show their first meaningful value, not raw JSON. */
export function inputPreview(input: string | undefined): string {
  const t = (input ?? "").trim();
  if (!t.startsWith("{")) return t;
  const m = /"(?:task|query|question|problem|thought|prompt|text|technique|code)"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(t);
  if (m) return m[1].replace(/\\n/g, " ").replace(/\\"/g, '"');
  const any = /"[^"]+"\s*:\s*"((?:[^"\\]|\\.){3,})/.exec(t);
  return any ? any[1] : t;
}

/** Search: keep the calls (and notes) whose tool, input or output contains every word of `q`. */
export function filterItems(items: Item[], q: string): Item[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return items;
  const hay = (it: Item) => {
    const c = it.call ?? it.loose!;
    return [c.title, c.input, c.inputFull, c.full ?? c.output, ...(it.group ?? []).map((n) => n.output), ...it.notes.map((n) => n.output)].join("\n").toLowerCase();
  };
  return items.filter((it) => words.every((w) => hay(it).includes(w)));
}

/** When following, open the call that most recently FINISHED (else the newest running one). */
export function followIndex(items: Item[]): number {
  let best = -1;
  let bestAt = -Infinity;
  items.forEach((it, i) => {
    const c = it.call; // follow calls; the brain's note rows never steal the view
    if (!c) return;
    const done = c.status !== "running";
    const at = (done ? 1e15 : 0) + c.ts + (c.ms ?? 0);
    if (at >= bestAt) {
      bestAt = at;
      best = i;
    }
  });
  return best;
}

export interface Item {
  call?: Card;
  /** model calls under it (trace stream) */
  models: Card[];
  /** what the watcher said about it */
  notes: Card[];
  /** a standalone watcher message (no call) — the latest one when several were coalesced */
  loose?: Card;
  /** consecutive standalone notes, shown as one "brain · N notes" row */
  group?: Card[];
}

/** Group cards into calls (with their models + notes) and loose watcher messages. */
export function groupItems(cards: Card[]): Item[] {
  const items: Item[] = [];
  const byKey = new Map<string, Item>();
  let current: Item | undefined;
  const watchCards: Card[] = [];
  for (const c of cards) {
    if (c.type === "note" || c.type === "answer" || c.type === "status") {
      watchCards.push(c);
      continue;
    }
    if (c.via === "tachibot") {
      current = { call: c, models: [], notes: [] };
      items.push(current);
      byKey.set(c.key, current);
    } else if (c.type === "span" || c.type === "thought") {
      if (c.depth > 0 && current) current.models.push(c);
      else if (c.depth === 0) {
        // a tachibot call made by another client (no transcript card) — still show it
        current = { call: { ...c, via: "tachibot", title: `tachibot · ${c.tool ?? c.title}` }, models: [], notes: [] };
        items.push(current);
        byKey.set(c.key, current);
      }
    }
  }
  // second pass: attach the brain's output to its call (restored notes come before
  // the replayed calls in the array); the rest are loose, ordered by time
  for (const c of watchCards) {
    const host = c.about ? byKey.get(c.about) : undefined;
    if (host) host.notes.push(c);
    // delivery receipts (sent / received) belong to the chat, not the calls list
    // answers without a call, and delivery receipts, live in the chat only
    else if (c.type === "note") items.push({ models: [], notes: [], loose: c });
  }
  const at = (it: Item) => (it.call ?? it.loose)!.ts;
  items.sort((a, b) => at(a) - at(b));
  // a run of the brain's session notes between two calls is one row, not six
  const out: Item[] = [];
  for (const it of items) {
    const prev = out[out.length - 1];
    if (it.loose?.type === "note" && prev?.loose?.type === "note") {
      prev.group = [...(prev.group ?? [prev.loose]), it.loose];
      prev.loose = it.loose;
    } else out.push(it);
  }
  return out;
}

/**
 * Undo tachibot's own soft wrapping (it wraps at ~80 columns for Claude's pane) so the
 * text re-wraps cleanly to THIS pane's width. A line is joined to the next when it is
 * long, the next starts mid-sentence (lowercase, or one-space continuation indent),
 * and neither is a list item, heading, table row, fence or blank line.
 */
export function reflow(text: string): string {
  const vis = (l: string) => l.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x07]*\x07/g, "");
  const structural = /^\s*([-*+•◦]\s|\d+[.)]\s|#{1,6}\s|\||```|>|[─━═┌└├│╭╰])/;
  const out: string[] = [];
  let fence = false;
  for (const line of text.split("\n")) {
    const v = vis(line);
    if (/^\s*```/.test(v)) fence = !fence;
    const prev = out.length ? vis(out[out.length - 1]) : "";
    const joinable = !fence && prev.trim().length >= 40 && !/[.:!?]$/.test(prev.trimEnd()) && !structural.test(prev.trimStart().slice(0, 4)) === true
      && v.trim() && !structural.test(v) && (/^ ?[a-z0-9(`'"$]/.test(v));
    if (joinable && !structural.test(prev)) out[out.length - 1] = `${out[out.length - 1].trimEnd()} ${line.trimStart()}`;
    else out.push(line);
  }
  return out.join("\n");
}

const visibleOf = (l: string) => l.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x07]*\x07/g, "");

/**
 * Clean tachibot's pre-rendered ANSI for the pane: drop SGR codes that lost their ESC
 * byte upstream ("1mThe…", "[1m"), and turn box-drawn tables wider than the pane into
 * stacked "header: value" records — hard-wrapping a grid breaks its borders apart.
 */
/** The design's type scale on tachibot's text: bold-only lines are headings, list markers are blue. */
const HEAD = "\x1b[1m\x1b[38;2;210;168;255m";
const MARK = "\x1b[38;2;121;192;255m";
const BRIGHT = "\x1b[38;2;240;246;252m";
const SUB = "\x1b[1m\x1b[38;2;121;192;255m";

/** Every visible character of the line sits on a background color: tachibot's heading pill. */
export function isPill(line: string): boolean {
  let bg = false, saw = false;
  const parts = line.split(/(\x1b\[[0-9;]*m)/);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      if (parts[i].trim() && !bg) return false;
      continue;
    }
    const codes = parts[i].slice(2, -1).split(";");
    for (let k = 0; k < codes.length; k++) {
      const c = codes[k];
      if (c === "38" || c === "48") {
        if (c === "48") bg = saw = true;
        k += codes[k + 1] === "5" ? 2 : 4; // 38/48;5;n or 38/48;2;r;g;b
      } else if (c === "49" || c === "0" || c === "") bg = false;
      else if (/^(4[0-7]|10[0-7])$/.test(c)) bg = saw = true;
    }
  }
  return saw;
}

export function styleAnsi(line: string): string {
  const v = visibleOf(line);
  if (!v.trim()) return line;
  // tachibot's heading pills (a background behind the whole line) → the reader's ▍ / ◆ headings
  if (isPill(line) && v.trim().length < 90) {
    const t = v.trim();
    return /^[•◦▪‣·-]\s/.test(t) ? `${SUB}◆ ${t.replace(/^[•◦▪‣·-]\s+/, "")}\x1b[0m` : `${HEAD}${t}\x1b[0m`;
  }
  // a bold title trailed by a rule ("🛠 SUMMARY ───") is a heading too
  const t0 = v.trim();
  const ruled = t0.length <= 90 && /^\s*\x1b\[1m/.test(line) ? /^(\S.{1,79}?) *─{2,}$/.exec(t0) : null;
  if (ruled) return `${HEAD}${ruled[1]}\x1b[0m`;
  // a whole line in bold (and nothing else) is a heading
  if (/^\s*\x1b\[1m[^\x1b]+\x1b\[(22|0)m\s*$/.test(line) && v.trim().length < 90) return `${HEAD}${v.trim()}\x1b[0m`;
  // "Key: value" at line start (short Capitalized key) → the key dimmed
  const kv = /^(\s*)([A-Z][A-Za-z _-]{1,22}):(\s+\S)/.exec(line);
  if (kv && !line.includes("\x1b")) line = `${kv[1]}\x1b[38;2;139;148;158m${kv[2]}:\x1b[39m${line.slice(kv[1].length + kv[2].length + 1)}`;
  let out = line
    .replace(/^(\s*)([•◦▪‣-]|\d{1,2}[.)])(\s)/, (_, sp: string, m: string, s2: string) => `${sp}${MARK}${m === "-" ? "•" : m}\x1b[39m${s2}`)
    .replace(/\x1b\[1m([^\x1b]+)\x1b\[22m/g, `\x1b[1m${BRIGHT}$1\x1b[39m\x1b[22m`);
  return out;
}

export function fitAnsi(text: string, width: number): string {
  const cleaned = text
    .replace(/(?<!\x1b)\[[0-9;]{1,8}m/g, "")
    .replace(/(^|[\s(])(?:\d{1,2};)*\d{0,2}m(?=[A-Z][a-z]|\d+\.\s)/gm, "$1");
  // tachibot's own "<provider> <tool>" (or "<tool>") chip line — the card header already says this
  const raw = cleaned.split("\n").filter((l, i) => !(i < 3 && /^\s*(?:[a-z]+\s+)?[a-z]+_[a-z_]+\s*$/.test(visibleOf(l))));
  // plain-text structure: "TITLE" over "=====", "--- SECTION ---" → headings; rules dropped
  const lines: string[] = [];
  for (let k = 0; k < raw.length; k++) {
    const v = visibleOf(raw[k]).trim();
    const under = k + 1 < raw.length && /^[=\-─]{6,}$/.test(visibleOf(raw[k + 1]).trim());
    const dashed = /^-{3,}\s*(.+?)\s*-{3,}$/.exec(v);
    if (/^[=\-─]{6,}$/.test(v)) continue;
    if (under && v) lines.push(`\x1b[1m${v}\x1b[22m`);
    else if (dashed) lines.push(`\x1b[1m${dashed[1]}\x1b[22m`);
    else lines.push(raw[k]);
  }
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*[╭┌]/.test(visibleOf(lines[i]))) {
      out.push(lines[i]);
      continue;
    }
    const block: string[] = [];
    while (i < lines.length && /^\s*[╭┌│├╰└┃]/.test(visibleOf(lines[i]))) block.push(lines[i++]);
    i--;
    const tooWide = block.some((l) => stringWidth(visibleOf(l)) > width);
    const rows = block.map(visibleOf).filter((l) => /^\s*[│┃]/.test(l)).map((l) => l.trim().replace(/^[│┃]|[│┃]$/g, "").split(/[│┃]/).map((c) => c.trim()));
    if (!tooWide || rows.length < 2) {
      out.push(...block);
      continue;
    }
    const [head, ...body] = rows;
    for (const r of body) {
      r.forEach((c, k) => out.push(k === 0 ? `\x1b[1m${c}\x1b[22m` : `  \x1b[2m${head[k] ?? ""}:\x1b[22m ${c}`));
      out.push("");
    }
  }
  return out.join("\n");
}

interface Line {
  text: string;
  /** a card section's header (STEPS, INPUT, OUTPUT) — the accordion folds what follows it */
  section?: string;
  /** pre-styled with ANSI (tachibot's own formatting) — render as-is */
  ansi?: boolean;
  color?: string;
  bold?: boolean;
  dim?: boolean;
  /** chat: the speaker's gutter color (a message bubble's left rule) */
  bar?: string;
  /** chat callouts: a tinted background across the full line */
  bg?: string;
}

/** The MODELS tab's carousel: one model's answer at a time (jurors, panel members, council roles). */
export function modelCarousel(it: Item, idx: number, width: number): Line[] {
  const answered = it.models.filter((m) => m.type !== "thought" && (m.full ?? m.output));
  if (answered.length < 2) return [];
  const i = ((idx % answered.length) + answered.length) % answered.length;
  const m = answered[i];
  const lines: Line[] = [
    { text: `◂ ${i + 1} / ${answered.length} ▸  ${shortModel(m.title)}${m.ms !== undefined ? `  ${(m.ms / 1000).toFixed(1)}s` : ""}`, color: "#79c0ff", bold: true },
    { text: "click ◂ ▸ or press [ ] to flip between the answers", dim: true },
    { text: "" },
  ];
  for (const l of renderMarkdown(readable(visibleOf(m.full ?? m.output ?? "")), width)) lines.push({ text: l, ansi: true });
  lines.push({ text: "" });
  return lines;
}

function detailLines(it: Item, width: number, reviewing: boolean, expanded = false): Line[] {
  const lines: Line[] = [];
  const push = (text: string, style: Omit<Line, "text"> = {}) => {
    for (const w of wrap(text, width)) lines.push({ text: w, ...style });
  };
  const section = (label: string, color: string) => lines.push({ text: label, color, bold: true, section: label.split(/\s/)[0] });
  const c = it.call!;

  // OpenUI Steps: the models this call ran, in order, as chips
  if (it.models.length) {
    section("STEPS", "#79c0ff");
    const steps = it.models.map((m) => ({ label: m.type === "thought" ? `thought ${m.title}` : shortModel(m.title), status: m.status }));
    // wrap between chips, never inside one
    let row: typeof steps = [];
    let used = 0;
    let start = 0;
    const flush = () => {
      if (row.length) lines.push({ text: stepsLine(row, 0, start), ansi: true });
      start += row.length;
    };
    for (const st of steps) {
      const w = stringWidth(st.label) + 7;
      if (row.length && used + w > width) {
        flush();
        row = [];
        used = 0;
      }
      row.push(st);
      used += w;
    }
    flush();
    lines.push({ text: "" });
  }

  // planner_maker (as designed): the step block heads the card, above its input
  // registered tool views: their headline block goes above INPUT (the planner's step block)
  const ctx = { tool: c.title.replace(/^tachibot · /, ""), output: visibleOf(c.fullAnsi ?? c.full ?? c.output ?? ""), width };
  const views = c.status === "error" || c.status === "running" ? [] : renderersFor(c.title);
  for (const l of views.flatMap((v) => v.top?.(ctx) ?? [])) lines.push({ text: l, ansi: true });

  section("INPUT", "#79c0ff");
  // arguments are often markdown (council briefs, perspectives): render them, argument names dimmed
  const inputText = c.inputFull || c.input || "(no arguments)";
  for (const l of renderMarkdown(readable(inputText), width)) {
    const key = /^([a-zA-Z_][\w]{0,30}):( |$)/.exec(l);
    lines.push({ text: key ? `\x1b[38;2;139;148;158m${key[1]}:\x1b[39m${l.slice(key[1].length + 1)}` : l, ansi: true });
  }
  lines.push({ text: "" });

  section(c.status === "running" ? "OUTPUT  (running…)" : "OUTPUT", c.status === "error" ? "#ff7b72" : "#7ee787");
  const out = c.full ?? c.output ?? "";
  // the tool's own renderer first (bars, chips, badges), then the full output
  const summary = c.status === "running" ? [] : toolCard(c.title, out, width);
  if (summary.length) {
    for (const l of summary) lines.push({ text: l, ansi: true });
    lines.push({ text: "" });
  }
  // a registered view may replace the output text (the planner: what the step block didn't cover)
  const custom = views.map((v) => v.output?.(ctx)).find((x) => x !== undefined);
  const planner = /planner_maker$/.test(c.title) ? parsePlanner(ctx.output) : undefined;
  if (custom) {
    for (const l of custom) lines.push({ text: l, ansi: true });
  } else if (planner?.rest) {
    for (const l of renderMarkdown(readable(planner.rest), width)) lines.push({ text: l, ansi: true });
  } else if (c.fullAnsi && c.status !== "error") {
    // tachibot's own terminal rendering: colored headers, tables, bullets
    for (const src of fitAnsi(reflow(c.fullAnsi), width).split("\n")) {
      const styled = styleAnsi(src);
      if (styled.startsWith(HEAD)) {
        // a heading: the reader's "▍" section mark; color kept on every wrapped row (wrap-ansi drops truecolor across rows)
        if (lines.length && lines[lines.length - 1].text !== "") lines.push({ text: "" });
        wrap(visibleOf(styled), width - 2).forEach((row, k) => lines.push({ text: `${HEAD}${k ? "  " : "▍ "}${row}\x1b[0m`, ansi: true }));
        continue;
      }
      if (styled.startsWith(SUB)) {
        if (lines.length && lines[lines.length - 1].text !== "") lines.push({ text: "" });
        wrap(visibleOf(styled), width).forEach((row, k) => lines.push({ text: `${SUB}${k ? "  " : ""}${row}\x1b[0m`, ansi: true }));
        continue;
      }
      if (!src.includes("\x1b") && src.length > 220) {
        // a dense plain paragraph: reader mode — "(1) … (2) …" lists, bold "Label:" lines
        for (const l of renderMarkdown(readable(src), width)) lines.push({ text: l, ansi: true });
        continue;
      }
      // list items wrap under their text, not under the bullet
      const hang = Math.min(/^\s*(?:[•◦▪‣-]|\d{1,2}[.)])\s+/.exec(visibleOf(styled))?.[0].length ?? 0, Math.floor(width / 2));
      wrapAnsi(linkifyAnsi(styled), width - hang, { hard: true, trim: false })
        .split("\n")
        .forEach((row, k) => lines.push({ text: k ? " ".repeat(hang) + row.replace(/^((?:\x1b\[[0-9;]*m)*) +/, "$1") : row, ansi: true }));
    }
  } else if (out && c.status === "error") {
    push(out, { color: "#ff7b72" });
  } else if (out) {
    // plain-text titles ("TITLE" over "====") and "--- SECTION ---" become markdown headings
    const md = reflow(out)
      .replace(/^(.+)\n[=]{6,}\s*$/gm, "## $1")
      .replace(/^-{3,}\s*(.+?)\s*-{3,}\s*$/gm, "### $1")
      .replace(/^[=\-─]{6,}\s*$/gm, "");
    for (const l of renderMarkdown(readable(md), width)) lines.push({ text: l, ansi: true });
  } else if (c.status === "running") {
    // a skeleton while the call runs: the answer's shape, not a blank
    for (const w of [0.7, 0.92, 0.55, 0.8]) lines.push({ text: "\x1b[38;2;33;38;45m" + "▆".repeat(Math.max(4, Math.floor(width * w))) + "\x1b[39m", ansi: true });
    lines.push({ text: "waiting for the answer…", dim: true });
  } else lines.push({ text: "(empty)", dim: true });

  // OpenUI Accordion, "behind the scenes": the model calls, folded until ctrl+b
  if (it.models.length) {
    lines.push({ text: "" });
    const falls = it.models.filter((m) => m.status === "fallback").length;
    lines.push({ text: `${expanded ? "▾" : "▸"} behind the scenes · ${it.models.length} model call${it.models.length > 1 ? "s" : ""}${falls ? ` · ${falls} fallback` : ""}  (ctrl+b)`, dim: !expanded, color: expanded ? "#79c0ff" : undefined });
    if (expanded) for (const m of it.models) {
      const i = ICON[m.status];
      const ms = m.ms !== undefined ? ` ${(m.ms / 1000).toFixed(1)}s` : m.status === "running" ? " running…" : "";
      const extra = m.status === "fallback" && m.cite ? `  → answered by ${m.cite}` : m.status === "error" && m.output ? `  ${m.output}` : "";
      push(`  ${"  ".repeat(Math.max(0, m.depth - 1))}${i.icon} ${m.type === "thought" ? `thought ${m.title}` : m.title}${ms}${extra}`, { color: i.color });
    }
  }

  // OpenUI Callout: what the second brain said, each with its source
  if (it.notes.length || reviewing) {
    const inner = width - 2;
    if (reviewing) {
      lines.push({ text: "" });
      lines.push({ text: "SECOND BRAIN · checking against memory…", color: THEME.note, bold: true, bar: THEME.note });
    }
    for (const n of it.notes) {
      lines.push({ text: "" });
      if (n.type === "note") {
        lines.push({ text: `SECOND BRAIN${n.cite ? ` · ${n.cite}` : ""}`, color: THEME.note, bold: true, bar: THEME.note });
        for (const w of wrap(n.output ?? "", inner)) lines.push({ text: w, color: "#e6d3a3", bar: THEME.note });
      } else if (n.type === "answer") {
        if (n.input) for (const w of wrap(`You: ${n.input}`, inner)) lines.push({ text: w, bold: true, bar: THEME.you });
        for (const l of renderMarkdown(n.output ?? "", inner)) lines.push({ text: l, ansi: true, bar: THEME.watcher });
      } else for (const w of wrap(n.output ?? "", inner)) lines.push({ text: w, dim: true, bar: "#8b949e" });
    }
  }
  return lines;
}

/**
 * The conversation with the second brain, pi-watcher style: numbered You / Watcher
 * turns, its own unprompted notes in between, the answer rendered as markdown,
 * and the pending question shown at once with a live "thinking" line.
 */
/** How long a fresh answer takes to type itself in. */
export const TYPE_MS = 1200;

export function chatLines(cards: Card[], asking: { question: string; since: number } | undefined, width: number, now = Date.now()): Line[] {
  const lines: Line[] = [];
  const push = (text: string, style: Omit<Line, "text"> = {}) => {
    for (const w of wrap(text, width)) lines.push({ text: w, ...style });
  };
  let you = 0;
  let watcher = 0;
  // every message is a bubble: a gutter rule in the speaker's color
  const inner = width - 2;
  const hhmm = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const askHead = (q: string, ts?: number) => {
    lines.push({ text: "" });
    lines.push({ text: `You #${++you}${ts ? ` · ${hhmm(ts)}` : ""}`, bold: true, color: THEME.you, bar: THEME.you });
    for (const w of wrap(q, inner)) lines.push({ text: w, bar: THEME.you });
  };
  const NOTE_BG = "#1c1a10";
  for (let ci = 0; ci < cards.length; ci++) {
    const c = cards[ci];
    if (c.type === "note" && c.cite === "now") {
      // running commentary: a run of "now" notes is ONE dim line — the latest — not a wall
      let last = ci;
      while (last + 1 < cards.length && cards[last + 1].type === "note" && cards[last + 1].cite === "now") last++;
      const run = last - ci;
      lines.push({ text: "" });
      const t = wrap(`◌ ${cards[last].output ?? ""}`, inner).slice(0, 2);
      t.forEach((w, k) => lines.push({ text: k === 1 && run ? `${w.slice(0, Math.max(0, inner - 12))}…` : w, color: THEME.muted }));
      if (run) lines.push({ text: `  +${run} earlier`, color: THEME.muted, dim: true });
      ci = last;
      continue;
    }
    if (c.type === "note") {
      // a finding: a tinted callout with its source
      lines.push({ text: "" });
      lines.push({ text: ` ${(c.cite ?? "note").toUpperCase()}`, bold: true, color: THEME.note, bg: NOTE_BG });
      const body = wrap(c.output ?? "", inner - 2);
      // a finding is a short callout: 3 lines, the rest behind "…"
      body.slice(0, 3).forEach((w, k) => lines.push({ text: ` ${k === 2 && body.length > 3 ? `${w.slice(0, Math.max(0, inner - 6))} …` : w}`, color: "#e6d3a3", bg: NOTE_BG }));
    } else if (c.type === "answer") {
      if (c.input && !c.input.startsWith("/send ")) askHead(c.input, c.ts);
      if (c.cite === "sent" || c.cite === "received" || (c.cite === "error" && !c.input)) {
        // receipts: one quiet line, not a message
        const via = /via (\S+)/.exec(c.output ?? "")?.[1]?.replace(/^claude\./, "");
        const text = c.cite === "received" ? `✓ Claude received it${via ? ` · ${via}` : ""}` : c.cite === "sent" ? "→ sent to Claude, waiting for receipt" : `✗ ${(c.output ?? "").replace(/^✗\s*/, "").slice(0, inner - 4)}`;
        lines.push({ text: `  ${text}`, color: c.cite === "received" ? THEME.ok : c.cite === "error" ? THEME.error : THEME.muted });
        continue;
      }
      const bar = c.cite === "error" ? THEME.error : THEME.watcher;
      lines.push({ text: "" });
      lines.push({ text: `Watcher #${++watcher} · ${hhmm(c.ts)}`, bold: true, color: bar, bar });
      // typewriter: a fresh answer types itself in over ~1.2s
      const full = c.output ?? "";
      const age = now - c.ts;
      const typing = age >= 0 && age < TYPE_MS && full.length > 0;
      const text = typing ? `${full.slice(0, Math.max(1, Math.floor((full.length * age) / TYPE_MS)))}▌` : full;
      for (const l of renderMarkdown(text, inner)) lines.push({ text: l, ansi: true, bar });
      if (c.context?.length) lines.push({ text: `▸ behind the scenes · ${c.context.join(" · ")}`, dim: true, bar });
    }
  }
  if (asking) {
    askHead(asking.question);
    lines.push({ text: "" });
    const spin = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[Math.floor(now / 90) % 10];
    lines.push({ text: `Watcher #${watcher + 1}  ${spin} thinking… ${Math.round((now - asking.since) / 1000)}s`, color: THEME.watcher, bar: THEME.watcher });
  }
  if (!lines.length) {
    push("Ask the second brain anything — it sees the tachibot calls, what Claude did, and your project memory.", { dim: true });
    push("Its answers and its own notes appear here. /send <text> sends to Claude; Tab goes back to the calls.", { dim: true });
  }
  return lines;
}

/** Wrapping a 20K-char answer is the expensive part of a frame — cache it per call state + width. */
const detailCache = new Map<string, Line[]>();
/** planner_maker phases seen this session, step → phase — the planner card names its segments with them */
let plannerPhases = new Map<number, PlannerStepInfo>();

/** Search matches marked in a (possibly ANSI) line: an amber background on each hit, escapes untouched. */
export function highlightAnsi(line: string, words: string[]): string {
  if (!words.length) return line;
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return line
    .split(/(\x1b\[[0-9;]*m|\x1b\]8;;[^\x07]*\x07)/)
    .map((part, i) => (i % 2 ? part : part.replace(re, "\x1b[48;2;92;72;18m$1\x1b[49m")))
    .join("");
}

/** "in 12.4k · out 3.1k" (+ reasoning) for a call: its own usage plus its model calls'. */
export function tokenTags(it: Item): Array<{ label: string; color?: string }> {
  const all = [it.call, ...it.models].filter((x): x is Card => !!x);
  const sum = (k: "tokensIn" | "tokensOut" | "tokensReasoning") => all.reduce((n, x) => n + (x[k] ?? 0), 0);
  const tin = sum("tokensIn");
  const tout = sum("tokensOut");
  const reason = sum("tokensReasoning");
  if (!tin && !tout) return [];
  const k = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  return [{ label: `in ${k(tin)} · out ${k(tout)}${reason ? ` · think ${k(reason)}` : ""}`, color: "#8b949e" }];
}

export type CardTab = "OUTPUT" | "INPUT" | "MODELS";

/** Which tab each card line belongs to: STEPS and "behind the scenes" → MODELS, INPUT → INPUT, the rest → OUTPUT. */
export function tabLines(lines: Line[]): Record<CardTab, Line[]> {
  const out: Record<CardTab, Line[]> = { OUTPUT: [], INPUT: [], MODELS: [] };
  let cur: CardTab = "OUTPUT";
  for (const l of lines) {
    if (l.section) cur = l.section === "INPUT" ? "INPUT" : l.section === "STEPS" ? "MODELS" : "OUTPUT";
    else if (/^[▸▾] behind the scenes/.test(l.text)) cur = "MODELS";
    else if (l.text.startsWith("SECOND BRAIN")) cur = "OUTPUT"; // the brain's note on this call reads with the output
    out[cur].push(l);
  }
  return out;
}

/** Card sections the viewer folded (an accordion): one set for every card, so INPUT stays folded as you move */
export const foldedSections = new Set<string>();

/** Fold the card's sections: a folded one keeps its header ("▸ INPUT"), its body becomes one line. */
export function foldLines(lines: Line[], folded: Set<string>): Line[] {
  const out: Line[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.section) { out.push(l); continue; }
    let end = i + 1;
    while (end < lines.length && !lines[end].section && !/^[▸▾] behind the scenes/.test(lines[end].text)) end++;
    const body = lines.slice(i + 1, end).filter((x) => x.text.trim());
    if (folded.has(l.section)) {
      out.push({ ...l, text: `▸ ${l.text}`, dim: true, bold: false });
      out.push({ text: `  ${body.length} line${body.length === 1 ? "" : "s"} folded · click the header to open`, dim: true });
      out.push({ text: "" });
      i = end - 1;
    } else out.push({ ...l, text: `▾ ${l.text}` });
  }
  return out;
}

function detailFor(it: Item, width: number, reviewing: boolean, expanded = false, modelIdx = 0): Line[] {
  if (!it.call) return [];
  const c = it.call;
  const k = `${modelIdx}|${[...foldedSections].join(",")}|${plannerPhases.size}|${c.key}|${c.status}|${c.fullAnsi?.length ?? c.full?.length ?? c.output?.length ?? 0}|${it.models.map((m) => m.status).join("")}|${it.notes.length}|${reviewing}|${width}|${expanded}`;
  let lines = detailCache.get(k);
  if (!lines) {
    // the carousel opens the MODELS tab (tabLines puts lines after the STEPS header there)
    const base = detailLines(it, width, reviewing, expanded);
    const carousel = modelCarousel(it, modelIdx, width);
    const stepsAt = base.findIndex((l) => l.section === "STEPS");
    const withCarousel = !carousel.length ? base
      : stepsAt >= 0 ? [...base.slice(0, stepsAt + 1), ...carousel, ...base.slice(stepsAt + 1)]
      : [...base, { text: "MODELS", section: "STEPS", bold: true }, ...carousel];
    lines = foldLines(withCarousel, foldedSections);
    if (detailCache.size > 200) detailCache.clear();
    detailCache.set(k, lines);
  }
  return lines;
}

/** A row whose note arrived in the last 2s pulses yellow. */
const PULSE_MS = 2000;
const PULSE_BG = "#3a3210";

function Row({ it, selected, reviewing, frame = 0, now = 0, inOpen = false, width = 40 }: { it: Item; selected: boolean; reviewing: boolean; frame?: number; now?: number; inOpen?: boolean; width?: number }) {
  const fresh = [...(it.group ?? []), ...(it.loose ? [it.loose] : []), ...it.notes].some((n) => n.type === "note" && now - n.ts < PULSE_MS);
  // the open question's calls sit on a tinted card; the selected one is highlighted on it
  const bg = selected ? SELECTED_BG : fresh && frame % 6 < 4 ? PULSE_BG : inOpen ? OPEN_BG : undefined;
  if (it.loose) {
    const n = it.loose;
    const color = n.type === "note" ? "#e3b341" : n.type === "answer" ? "#79c0ff" : "#8b949e";
    const label = it.group ? `brain · ${it.group.length} notes` : n.cite ? n.cite : n.type === "note" ? "brain" : "";
    return (
      <Box height={1} overflow="hidden" backgroundColor={bg}>
        <Text wrap="truncate-end" dimColor={n.type === "status"}>
          <Text color={THEME.chat}>{selected ? "▸ " : "  "}</Text>
          <Text color={color}>{n.type === "note" ? "◆ " : n.type === "answer" ? "◇ " : ""}</Text>
          {label ? <Text color={color}>{label}</Text> : null}
          <Text color={THEME.muted}>{label ? "  " : ""}{(n.output ?? "").replace(/\s+/g, " ")}</Text>
        </Text>
      </Box>
    );
  }
  const c = it.call!;
  const i = ICON[c.status];
  const noteCount = it.notes.filter((n) => n.type === "note").length;
  const ms = c.status === "running" ? now - c.ts : c.ms;
  const right = ms === undefined ? time(c.ts) : ms < 60_000 ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s` : `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}`;
  const name = c.title.replace(/^tachibot · /, "");
  // a short hint after the name: the planner's step, else the input's first words
  const step = /planner_maker$/.test(name) ? /Step\s+(\d+)\s*\/\s*(\d+)/.exec(c.output ?? c.full ?? "") : null;
  const rightW = 7 + (noteCount ? 3 + String(noteCount).length : 0) + (reviewing ? 2 : 0);
  // a hint shows whole or not at all — never "Draft th…"; long inputs keep their first words only if they fit
  const room = Math.max(0, width - 6 - stringWidth(name) - rightW - 2);
  const words = (inputPreview(c.input) ?? "").split(/\s+/);
  let fit = "";
  for (const w of words) { if (stringWidth(`${fit} ${w}`.trim()) > room) break; fit = `${fit} ${w}`.trim(); }
  const hint = step ? (room >= 4 ? `${step[1]}/${step[2]}` : "") : fit;
  return (
    <Box height={1} overflow="hidden" backgroundColor={bg}>
      <Box flexGrow={1} flexShrink={1} overflow="hidden">
        <Text wrap="truncate-end">
          <Text color={THEME.chat}>{selected ? "▸ " : "  "}</Text>
          {c.status === "running" ? <Spinner frame={frame} color={i.color} />
            : selected ? <Text color={THEME.note}>◉</Text>
            : <Text color={i.color}>{c.status === "ok" ? "●" : i.icon}</Text>}
          <Text> </Text>
          {c.status === "running"
            ? <Shimmer text={name} frame={frame} />
            : <Text bold={selected} color={c.status === "error" ? "#ff7b72" : selected ? "#f0f6fc" : "#7ee787"}>{name}</Text>}
          {hint ? <Text color={step ? THEME.prompts : THEME.muted}>{`  ${hint}`}</Text> : null}
        </Text>
      </Box>
      <Box width={rightW} flexShrink={0} justifyContent="flex-end">
        <Text>
          {reviewing ? <Spinner frame={frame} color="#e3b341" /> : null}
          {noteCount ? <Text color="#e3b341">{` ●${noteCount}`}</Text> : null}
          <Text color={THEME.muted}>{` ${right.padStart(5)}`}</Text>
        </Text>
      </Box>
    </Box>
  );
}

/** Lay out stat chips left to right with 2-space gaps, dropping the ones that don't fit. */
function statsRow(width: number, parts: Array<[number, ReactNode]>): ReactNode {
  const shown: ReactNode[] = [];
  let used = 0;
  for (const [w, node] of parts) {
    if (!node) continue;
    if (used + w + (shown.length ? 2 : 0) > width) continue;
    if (shown.length) shown.push(<Text key={`g${shown.length}`}>{"  "}</Text>);
    shown.push(node);
    used += w + 2;
  }
  return <Text>{shown}</Text>;
}

function Header({ s, calls, width, status, view, chatCount, frame }: { s: WatchState; calls: Item[]; width: number; status?: Card; view: View; chatCount: number; frame: number }) {
  const spark = sparkline(calls.slice(-16).map((i) => i.call?.ms ?? 0));
  const traced = s.tachibot.startsWith("connected");
  const errors = calls.filter((i) => i.call?.status === "error").length;
  const fallbacks = calls.filter((i) => i.call?.status === "fallback" || i.models.some((m) => m.status === "fallback")).length;
  const notes = calls.reduce((n, i) => n + i.notes.filter((x) => x.type === "note").length, 0);
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Box justifyContent="space-between" height={1} overflow="hidden">
        <Box flexShrink={1} overflow="hidden">
          <Text bold wrap="truncate-end">
            tachi-watch{width >= 60 ? <Text dimColor> · {s.session.slice(0, 8)}</Text> : null}
          </Text>
        </Box>
        <Box flexShrink={0}>
          <Text>
            {s.reviewing ? <Text><Spinner frame={frame} color="#e3b341" /><Text color="#e3b341"> review </Text></Text> : null}
            {s.thinking ? <Text><Spinner frame={frame + 3} color="#79c0ff" /><Text color="#79c0ff"> think </Text></Text> : null}
            <Tag label={s.brain} color={THEME.chat} />
          </Text>
        </Box>
      </Box>
      <Box height={1} overflow="hidden">{statsRow(width, [
        // [text width, node] in priority order — whatever doesn't fit is left out, never cut
        [String(calls.length).length + 6, <Text key="c"><Text color="#7ee787">{calls.length}</Text><Text dimColor> calls</Text></Text>],
        [errors ? String(errors).length + 7 : 0, errors ? <Text key="e" color="#ff7b72">{errors} errors</Text> : null],
        [fallbacks ? String(fallbacks).length + 10 : 0, fallbacks ? <Text key="f" color="#e3b341">{fallbacks} fallbacks</Text> : null],
        [String(notes).length + 6, <Text key="n"><Text color={notes ? "#e3b341" : "#8b949e"}>{notes}</Text><Text dimColor> notes</Text></Text>],
        [spark.length + 10, spark ? <Text key="s"><Text color={THEME.muted}>call time </Text><Text color="#56d364">{spark}</Text></Text> : null],
        [traced ? 13 : 35, <Text key="m"><Text color={traced ? "#7ee787" : "#8b949e"}>{traced ? "●" : "○"}</Text><Text dimColor>{traced ? " model trace" : " model trace off"}</Text>{traced ? null : <Text color={THEME.note}> · /mcp reconnect</Text>}</Text>],
        [s.memory.length + 2, <Text key="mem"><Text color="#7ee787">●</Text><Text dimColor> {s.memory}</Text></Text>],
      ])}</Box>
      {status ? <Text dimColor wrap="truncate-end">{status.output}</Text> : null}
      <TabBar view={view} calls={calls.length} chat={chatCount} prompts={s.techniques?.length} memory={s.memoryList.length} busy={!!s.asking} />
    </Box>
  );
}

const WIDE_COLS = 140;
const STATUS_MS = 8000;
const LIST_W = 46;
const CHAT_W = 48;

export const START_SUGGESTIONS = [
  "what did we decide in this session so far?",
  "anything in memory Claude is ignoring?",
  "summarise the last council",
];

/** Before the first tachibot call: what is connected, what was resumed, what to try. */
function StartPage({ s, width, calls, height = 99 }: { s: WatchState; width: number; calls: Item[]; height?: number }) {
  const last = calls[calls.length - 1]?.call;
  const running = calls.filter((i) => i.call?.status === "running").length;
  const resumed = s.cards.filter((c) => c.type === "note").length;
  const answers = s.cards.filter((c) => c.type === "answer" && c.input).length;
  const traced = s.tachibot.startsWith("connected");
  const check = (ok: boolean | "warn", label: string, detail: string) => (
    <Box key={label} justifyContent="space-between" height={1} overflow="hidden">
      <Text><Text color={ok === "warn" ? "#e3b341" : ok ? "#7ee787" : "#ff7b72"}>{ok === "warn" ? "!" : ok ? "✓" : "✗"}</Text> {label}</Text>
      <Text dimColor wrap="truncate-end">{detail}</Text>
    </Box>
  );
  const box = { borderStyle: "round" as const, borderColor: "#8b949e", paddingX: 1, flexDirection: "column" as const, flexShrink: 0 };
  // A short pane shows fewer sections, never squeezed ones: each is taken only if all its rows
  // (gap included) still fit. The ready check always shows; then the session, TRY, MEMORY, the legend.
  const TAGLINE = "second brain beside Claude — every tachibot call in full, checked against your memory";
  // (Rows are counted, not clipped: Ink does not clip a row that has its own overflow box.)
  const titleRows = 1 + Math.ceil(TAGLINE.length / Math.max(20, Math.min(width, 90))) + 1; // name, tagline, gap
  const showTitle = 1 + titleRows + 8 <= height;
  const checks = [
    check(true, "Claude session", s.session.slice(0, 8)),
    check(traced ? true : "warn", "tachibot trace", traced ? "connected · models live" : s.tachibot),
    check(true, "memory", s.memory),
    check(s.target || s.hooks ? true : "warn", "send to Claude", s.target ? `pane ${s.target.slice(0, 12)}` : s.hooks ? "Claude Code hooks" : "copy/paste · watch --install-hooks"),
    check(true, "brain", s.brain),
  ].slice(0, Math.max(0, height - 1 - (showTitle ? titleRows : 0) - 3));
  let used = 1 + (showTitle ? titleRows : 0) + 3 + checks.length;
  const take = (rows: number) => used + rows <= height && ((used += rows), true);
  const showSession = (calls.length > 0 || resumed > 0 || answers > 0) && take(calls.length ? (last ? 7 : 6) : 5);
  const showTry = take(7);
  const showMemory = take(8);
  const showLegend = take(5);
  return (
    <Box flexDirection="column" gap={1} paddingTop={1} width={Math.min(width, 90)} height={height} overflow="hidden">
      {showTitle ? <Box flexDirection="column" flexShrink={0}>
        <Text bold color={THEME.calls}>t a c h i · w a t c h</Text>
        <Text dimColor wrap="wrap">{TAGLINE}</Text>
      </Box> : null}
      {checks.length ? <Box {...box}>
        <Text bold color={THEME.chat}>READY CHECK</Text>
        {checks}
      </Box> : null}
      {showSession && calls.length ? (
        <Box {...box}>
          <Text bold color={THEME.chat}>THIS SESSION</Text>
          <Text wrap="truncate-end"><Text color="#7ee787">{calls.length}</Text> tachibot calls{running ? <Text color="#e3b341"> · {running} running</Text> : null} · <Text color="#e3b341">●</Text> {resumed} notes · <Text color="#79c0ff">◇</Text> {answers} answers</Text>
          {last ? <Text dimColor wrap="truncate-end">latest: {last.title.replace(/^tachibot · /, "")} — {last.input}</Text> : null}
          <Text dimColor wrap="truncate-end">↑↓ or Tab → open the calls</Text>
        </Box>
      ) : showSession ? (
        <Box {...box}>
          <Text bold color={THEME.chat}>RESUMED FROM LAST RUN</Text>
          <Text><Text color="#e3b341">●</Text> {resumed} brain notes · <Text color="#79c0ff">◇</Text> {answers} answers</Text>
        </Box>
      ) : null}
      {showMemory ? (
        <Box {...box}>
          <Text bold color={THEME.chat} wrap="truncate-end">MEMORY <Text color={THEME.muted} bold={false}>· what the second brain checks calls against</Text></Text>
          {([
            ["project", s.memoryList.filter((f) => !f.startsWith("~") && !f.startsWith("dokoro/"))],
            ["Claude memory", s.memoryList.filter((f) => f.startsWith("~"))],
            ["dokoro files", s.memoryList.filter((f) => f.startsWith("dokoro/"))],
          ] as Array<[string, string[]]>).map(([label, list]) => (
            <Text key={label} wrap="truncate-end">
              <Text color={list.length ? THEME.ok : THEME.muted}>{list.length ? "✓" : "·"}</Text>
              <Text>{` ${label.padEnd(14)}`}</Text>
              <Text color={THEME.muted}>{list.length ? list.map((f) => f.split("/").pop()).join(" · ") : "none"}</Text>
            </Text>
          ))}
          <Text wrap="truncate-end"><Text color={s.dokoroSearch ? THEME.ok : THEME.muted}>{s.dokoroSearch ? "✓" : "·"}</Text>{` ${"dokoro search".padEnd(14)}`}<Text color={THEME.muted}>{s.dokoroSearch ? "connected — recall on every review" : "not connected (set memory.dokoroCmd)"}</Text></Text>
        </Box>
      ) : null}
      {showTry ? <Box {...box}>
        <Text bold color={THEME.chat}>TRY</Text>
        {START_SUGGESTIONS.map((q, i) => (
          <Text key={i} wrap="truncate-end"><Text bold color={THEME.chat}>{i + 1} › </Text>{q}</Text>
        ))}
      </Box> : null}
      {showLegend ? <Box borderStyle="round" borderColor="#8b949e" borderDimColor paddingX={1} flexDirection="column" flexShrink={0}>
        <Text dimColor wrap="truncate-end"><Text bold color="#f0f6fc">Tab</Text> calls ⇄ chat  <Text bold color="#f0f6fc">^G</Text> home  <Text bold color="#f0f6fc">^S</Text> send  <Text bold color="#f0f6fc">^B</Text> details  <Text bold color="#f0f6fc">@claude</Text> text → Claude</Text>
        <Text dimColor wrap="truncate-end"><Text color="#7ee787">✓</Text> ok  <Text color="#ff7b72">✗</Text> error  <Text color="#e3b341">↳</Text> fell back  <Text color="#e3b341">●</Text> brain notes  <Text color="#56d364">◆</Text> model calls</Text>
      </Box> : null}
    </Box>
  );
}

/** MEMORY: the files the second brain reads — browse them, rendered as markdown. */
/**
 * Reader mode for dense notes (planner / council records): inside a long paragraph,
 * "(1) … (2) …" becomes one list item each and "Label: …" labels start a bold line.
 * Short paragraphs, lists, headings and code are left alone.
 */
export function readable(md: string): string {
  let fence = false;
  return md.split("\n").map((line) => {
    if (/^\s*```/.test(line)) fence = !fence;
    if (fence || line.length < 220 || /^\s*([#>|]|[-*•]\s|\d+[.)]\s)/.test(line)) return line;
    let out = line
      // "(1) ", "(2) " … → list items
      .replace(/\s*\((\d{1,2})\)\s+/g, (_m, n: string) => `\n${n}. `)
      // "Ranking: ", "Risks: " (a capitalised label of 1–3 words after a sentence end) → bold label line
      .replace(/([.;)])\s+([A-Z][a-z]+(?: [a-z]+){0,2}):[ \t]+/g, (_m, end: string, label: string) => `${end}\n\n**${label}:** `)
      // a label directly followed by its first list item: the item goes on its own line
      .replace(/(\*\*[^*\n]+:\*\*) (?=\n?1\. )/g, "$1\n");
    // a leading "Label: " too
    out = out.replace(/^([A-Z][A-Za-z]+(?: [a-z]+){0,2}):[ \t]+/, "**$1:** ");
    return out;
  }).join("\n");
}

/** Where each OSC 8 link sits in a rendered line: visible column span (0-based, end exclusive) and url. */
export function linkSpans(line: string): Array<{ from: number; to: number; url: string }> {
  const out: Array<{ from: number; to: number; url: string }> = [];
  let col = 0;
  let open: { from: number; url: string } | null = null;
  for (let i = 0; i < line.length; ) {
    const osc = /^\x1b\]8;;([^\x07]*)\x07/.exec(line.slice(i, i + 2048));
    if (osc) {
      if (osc[1]) open = { from: col, url: osc[1] };
      else if (open) { out.push({ from: open.from, to: col, url: open.url }); open = null; }
      i += osc[0].length;
      continue;
    }
    const sgr = /^\x1b\[[0-9;]*m/.exec(line.slice(i, i + 32));
    if (sgr) { i += sgr[0].length; continue; }
    const cp = line.codePointAt(i)!;
    i += cp > 0xffff ? 2 : 1;
    col += stringWidth(String.fromCodePoint(cp));
  }
  return out;
}

const BROWSER = process.env.TACHI_BROWSER ?? "Google Chrome";
/** open a url in the browser (Chrome by default; TACHI_BROWSER overrides, "default" = the system's) */
export function openUrl(url: string): void {
  if (!/^https?:\/\//.test(url)) return;
  const args = process.platform === "darwin" ? (BROWSER === "default" ? [url] : ["-a", BROWSER, url]) : [url];
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  try { spawn(cmd, args, { stdio: "ignore", detached: true }).unref(); } catch { /* no browser: nothing to do */ }
}

/** dokoro note names: "2026-10-31-00h55m-saturday-plan-next-…" → "plan-next-… · 10-31 00:55" */
export function noteName(file: string): string {
  const base = file.split("/").pop() ?? file;
  const m = /^\d{4}-(\d{2}-\d{2})-(\d{2})h(\d{2})m-(?:[a-z]+day-)?(.+?)\.md$/.exec(base);
  return m ? `${m[4]} · ${m[1]} ${m[2]}:${m[3]}` : base;
}

/**
 * An ISO timestamp as people read it, in local time: "Wed 1 Jul 2026 · 23:51 ☾ evening · 4 months ago".
 * Anything that is not a full ISO date-time comes back unchanged.
 */
export function humanTime(value: string, now = Date.now()): string {
  const m = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(value.trim());
  if (!m) return value;
  const d = new Date(value.trim());
  if (Number.isNaN(d.getTime())) return value;
  const dateOnly = !/[T ]\d{2}:\d{2}/.test(value);
  const day = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" }).replace(",", "");
  const ago = (() => {
    const s = Math.round((now - d.getTime()) / 1000);
    const a = Math.abs(s);
    const unit = a < 3600 ? [Math.round(a / 60), "minute"] : a < 86400 ? [Math.round(a / 3600), "hour"] : a < 86400 * 45 ? [Math.round(a / 86400), "day"] : a < 86400 * 365 ? [Math.round(a / (86400 * 30)), "month"] : [Math.round(a / (86400 * 365)), "year"];
    const txt = `${unit[0]} ${unit[1]}${unit[0] === 1 ? "" : "s"}`;
    return a < 60 ? "just now" : s >= 0 ? `${txt} ago` : `in ${txt}`;
  })();
  if (dateOnly) return `${day} · ${ago}`;
  const h = d.getHours();
  const part = h >= 5 && h < 12 ? "☼ morning" : h >= 12 && h < 14 ? "☀ midday" : h >= 14 && h < 18 ? "◑ afternoon" : h >= 18 && h < 22 ? "☾ evening" : "✦ night";
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return `${day} · ${time} ${part} · ${ago}`;
}

/** YAML front matter ("---\nkey: value\n---") → a PROPERTIES block: dimmed keys, unquoted values. */
export function frontMatter(text: string): { props: Array<[string, string]>; body: string } {
  const m = /^\s*---\s*\n([\s\S]*?)\n---\s*\n?/.exec(text);
  if (!m) return { props: [], body: text };
  const props = m[1].split("\n").map((l) => /^([\w.-]+):\s*(.*)$/.exec(l)).filter((x): x is RegExpExecArray => !!x).map((x) => [x[1], x[2].replace(/^["']|["']$/g, "")] as [string, string]);
  return { props, body: text.slice(m[0].length) };
}

function MemoryView({ cwd, files, sel, off, width, rows, dokoroSearch, focus, focusColor, raw, folded = new Set<string>(), onHeads, onMax, onLinks, onRows }: { cwd: string; files: string[]; sel: number; off: number; width: number; rows: number; dokoroSearch: boolean; focus: "files" | "doc"; focusColor: string; raw?: boolean; folded?: Set<string>; onHeads?: (rows: number[]) => void; onMax?: (n: number) => void; onLinks?: (zones: Array<{ row: number; from: number; to: number; url: string }>, left: number) => void; onRows?: (offset: number, width: number, targets: Array<number | undefined>) => void }) {
  const listW = Math.max(30, Math.min(48, Math.floor(width * 0.34)));
  const docW = width - listW - 1;
  const group = (f: string) => (f.startsWith("~") ? "CLAUDE MEMORY" : f.startsWith("dokoro/") ? "DOKORO" : "PROJECT");
  const path = files[sel];
  const abs = path ? (path.startsWith("~") ? path.replace("~", homedir()) : `${cwd}/${path}`) : "";
  let text = "";
  try {
    text = abs ? fs.readFileSync(abs, "utf8") : "";
  } catch {
    text = "(could not read the file)";
  }
  const { props, body: mdBody } = frontMatter(text.slice(0, 200_000));
  const keyW = Math.min(16, Math.max(0, ...props.map(([k]) => k.length)));
  const innerW = docW - 5; // border, padding, scroll thumb
  // PROPERTIES: a tinted block; status-like values become pills
  const tint = (l: string) => `\x1b[48;2;22;27;34m${l}${" ".repeat(Math.max(0, innerW - stringWidth(l.replace(/\x1b\[[0-9;]*m/g, ""))))}\x1b[49m`;
  const pill = (k: string, v: string) => /^(status|state|type|priority)$/i.test(k) && v.length < 24 ? `\x1b[48;2;42;31;10m\x1b[38;2;227;179;65m ${v} \x1b[39m\x1b[48;2;22;27;34m` : v;
  const propLines = props.length
    ? [
        ...props.map(([k, v0]) => [k, humanTime(v0)] as const).flatMap(([k, v]) => wrap(v, Math.max(10, innerW - 4 - keyW)).map((w, i) => tint(` ${i ? " ".repeat(keyW) : `\x1b[38;2;139;148;158m${k.padEnd(keyW)}\x1b[39m`}  ${i ? w : pill(k, w)}`))),
        "",
      ]
    : [];
  const doc = raw
    ? text.slice(0, 200_000).split("\n").flatMap((l) => wrap(l, innerW)).map((l) => `\x1b[38;2;201;209;217m${l}\x1b[39m`)
    : [...propLines, ...renderMarkdown(readable(reflow(mdBody)), innerW)];
  // heading rows (the reader's ▍ / ◆ marks, or the H1 rule's title) for ^O
  onHeads?.(doc.map((l, i) => (/^(▍|◆) /.test(visibleOf(l)) || /^━+$/.test(visibleOf(doc[i + 1] ?? "")) || (raw && /^#{1,3} /.test(visibleOf(l))) ? i : -1)).filter((i) => i >= 0));
  if (!files.length) {
    return (
      <Box flexDirection="column" paddingTop={1}>
        <Text color={THEME.note}>no memory files yet</Text>
        <Text color={THEME.muted}>The second brain reads CLAUDE.md, AGENTS.md, .remember/, your Claude memory and dokoro/ (current.md, daily/, sessions/).</Text>
        <Text color={THEME.muted}>Add any of them — or list extra files under "memory.files" in ~/.tachi/watch.json.</Text>
      </Box>
    );
  }
  const room = Math.max(4, rows - 3);
  const o = Math.min(off, Math.max(0, doc.length - room));
  onMax?.(Math.max(0, doc.length - room));
  const shown = doc.slice(o, o + room);
  // links in the visible lines, in body coordinates (row 0 = the first doc line), for clicks
  onLinks?.(shown.flatMap((l, r) => linkSpans(l).map((z) => ({ row: r, from: z.from, to: z.to, url: z.url }))), listW + 1 + 2);
  // scroll thumb: where the window sits in the document
  const thumbH = Math.max(1, Math.round((room * room) / Math.max(room, doc.length)));
  const thumbAt = doc.length > room ? Math.round((o / Math.max(1, doc.length - room)) * (room - thumbH)) : 0;
  const pct = doc.length > room ? Math.round(((o + room) / doc.length) * 100) : 100;
  const folder = path?.startsWith("dokoro/") ? path.split("/").slice(0, -1).join("/") : path?.startsWith("~") ? "claude memory" : "project";
  let last = "";
  {
    // the rows the file list draws: a group header (not clickable) before each new group, then the file
    const targets: Array<number | undefined> = [];
    let g0 = "";
    files.slice(0, rows - 3).forEach((f, i) => {
      if (group(f) !== g0) targets.push(undefined);
      g0 = group(f);
      if (!folded.has(g0)) targets.push(i);
    });
    onRows?.(2, listW, targets);
  }
  return (
    <Box flexDirection="row" gap={1}>
      <Box flexDirection="column" width={listW} flexShrink={0} overflow="hidden" borderStyle={focus === "files" ? "bold" : "round"} borderColor={focus === "files" ? focusColor : "#30363d"} paddingX={1}>
        <Text wrap="truncate-end">{focus === "files" ? <Text backgroundColor={THEME.memory} color="#0d1117" bold>{" FILES "}</Text> : <Text color={THEME.muted}>FILES</Text>}<Text bold color={THEME.memory}>{`  ${files.length}`}</Text><Text color={THEME.muted}>{dokoroSearch ? " · dokoro search on" : ""}</Text></Text>
        {files.slice(0, rows - 3).map((f, i) => {
          const g = group(f);
          const head = g !== last ? g : "";
          last = g;
          return (
            <Box key={f} flexDirection="column">
              {head ? <Text color={THEME.muted}>{`${folded.has(head) ? "▸" : "▾"} ${head}`}<Text color="#30363d">{folded.has(head) ? `  ${files.filter((x) => group(x) === head).length} hidden` : ""}</Text></Text> : null}
              {folded.has(g) ? null : <Box height={1} overflow="hidden" backgroundColor={i === sel ? SELECTED_BG : undefined}>
                <Text wrap="truncate-end">{i === sel ? "▸ " : "  "}<Text color={g === "DOKORO" ? THEME.memory : THEME.text}>{g === "DOKORO" ? noteName(f) : f.split("/").pop()}</Text><Text color={THEME.muted}>{f.includes("/daily/") ? "  daily" : f.includes("/sessions/") ? "  session" : ""}</Text></Text>
              </Box>}
            </Box>
          );
        })}
      </Box>
      <Box flexDirection="column" width={docW} flexShrink={0} overflow="hidden" borderStyle={focus === "doc" ? "bold" : "round"} borderColor={focus === "doc" ? focusColor : "#30363d"} paddingX={1}>
        <Box>
          <Box flexGrow={1} flexShrink={1} overflow="hidden"><Text wrap="truncate-end">{focus === "doc" ? <Text backgroundColor={THEME.memory} color="#0d1117" bold>{" DOC "}</Text> : <Text color={THEME.muted}>DOC</Text>}<Text>  </Text><Text bold color="#f0f6fc">{path ? noteName(path) : ""}</Text><Text>  </Text><Text backgroundColor={THEME.tagBg} color={THEME.muted}>{` ${folder} `}</Text>{raw ? <Text color={THEME.note}>{"  RAW"}</Text> : null}</Text></Box>
          <Text color={THEME.memory}>{" "}</Text>
          <Text color={THEME.memory}>{`${o + 1}–${Math.min(doc.length, o + room)} / ${doc.length} · ${pct}%`}</Text>
        </Box>
        <Box flexDirection="row">
          <Box flexDirection="column" flexGrow={1} overflow="hidden">
            {shown.map((l, i) => <Text key={i} wrap="truncate-end">{l || " "}</Text>)}
          </Box>
          <Box flexDirection="column" width={1} flexShrink={0}>
            {shown.map((_, i) => <Text key={i} color={i >= thumbAt && i < thumbAt + thumbH ? THEME.memory : "#21262d"}>{doc.length > room ? "▐" : " "}</Text>)}
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

/** Every key, per tab — the help overlay renders from this so it cannot drift from what works. */
export const KEYS: Record<View | "all", Array<[string, string]>> = {
  all: [["Tab / Shift+Tab", "next / previous tab (HOME → CALLS → CHAT → PROMPTS → MEMORY)"], ["click", "a tab, a call, a file, a technique, a pane"], ["^Y", "copy the open call / file / last answer"], ["^P · ^K", "pin the open call to the top · export it as markdown (dokoro/daily)"], ["^O", "mark the open call, open another: compare side by side (Esc ends)"], ["[ ]", "MODELS tab: flip between the models' answers"], ["^N", "solo chat: hide the brain's notes"], ["drag", "select text: copied, and attached to your next question (Esc drops)"], ["^X", "terminal select mode (Esc returns)"], ["click a link", "opens in Chrome (TACHI_BROWSER to change)"], ["Esc", "back out one layer — typed text, then the tab → HOME"], ["^F", "search every call output, hits marked in the card (CHAT: the conversation)"], ["^T", "compact / normal density"], ["?", "this help"], ["^S · ^E", "send / edit the brain's proposal to Claude"], ["@claude <text>", "send your own text to Claude"], ["^C", "quit"]],
  home: [["↑↓", "open the calls"], ["1-3", "ask a suggested question"]],
  calls: [["←→", "split: focus list · card · chat (keys act on the focused pane)"], ["↑↓", "move in the focused pane (list: select · card: line · chat: scroll)"], ["g / G", "top / end of the focused pane (input empty)"], ["PgUp/PgDn", "scroll the card a page"], ["wheel", "scrolls the pane under the pointer"], ["^B", "behind the scenes (model calls)"], ["/label <name>", "name this question group"], ["/layout auto|split|stack", "columns"], ["Enter", "ask the brain about this call"]],
  chat: [["↑↓ PgUp/PgDn", "scroll — scrolling up pauses, ↓ to the end resumes"], ["1-3", "ask a follow-up"], ["Enter", "ask the brain"]],
  memory: [["click", "open a file · focus a pane"], ["^Y", "copy the file"], ["^O", "jump to the next heading"], ["^R", "raw markdown ⇄ reader"], ["←→ / Enter", "focus the file list or the document"], ["↑↓", "pick a file · or scroll the document"], ["PgUp/PgDn", "scroll a page"], ["g / G", "top / end"], ["wheel", "scrolls the document"]],
  prompts: [["type", "rank techniques for your task"], ["↑↓", "pick"], ["←→", "category"], ["^O", "core only"], ["^R", "codex picks the best 3"], ["Enter", "propose applying it to Claude"], ["^Y", "copy the name"], ["Esc", "clear every filter"]],
};

function HelpView({ view, width }: { view: View; width: number }) {
  const row = ([k, d]: [string, string], i: number) => (
    <Text key={i} wrap="truncate-end"><Text color={THEME.chat} bold>{k.padEnd(26)}</Text><Text color={THEME.text}>{d}</Text></Text>
  );
  return (
    <Box flexDirection="column" paddingTop={1} width={Math.min(width, 100)}>
      <Text bold color={THEME.prompts}>{`KEYS · ${view.toUpperCase()}`}<Text color={THEME.muted}>   ? or Esc closes</Text></Text>
      <Text> </Text>
      {KEYS[view].map(row)}
      <Text> </Text>
      <Text bold color={THEME.muted}>EVERYWHERE</Text>
      {KEYS.all.map(row)}
    </Box>
  );
}

/** PROMPTS: tachibot's technique catalog, ranked for the task you type; detail of the picked one. */
function PromptsView({ list, total, from, sel, query, width, rows, categories, catIdx, coreOnly, recommended, frame, onRows }: {
  list: Technique[]; total?: number; from?: string; sel: number; query: string; width: number; rows: number; onRows?: (offset: number, width: number, targets: Array<number | undefined>) => void;
  categories: string[]; catIdx: number; coreOnly: boolean; recommended?: WatchState["recommended"]; frame: number;
}) {
  if (total === undefined) return <Box paddingTop={1}><Text color={THEME.muted}>loading tachibot's prompt techniques…</Text></Box>;
  if (!total) return <Box paddingTop={1}><Text color={THEME.muted}>this build has no technique catalog</Text></Box>;
  const side = width >= 90;
  const listW = side ? Math.max(30, Math.floor(width * 0.4)) : width;
  const picksRow = recommended ? 1 + (recommended.picks.length ? 1 : 0) : 0;
  const listRows = (side ? rows : Math.max(8, Math.floor(rows / 2))) - 2 /* border */ - 1 /* head */ - 1 /* chips */ - picksRow;
  // filter chips: the selected category in view, its neighbours around it
  const from0 = Math.max(0, Math.min(catIdx - 3, categories.length - 7));
  const chips = (
    <Box height={1} overflow="hidden">
      <Text wrap="truncate-end">
        {from0 > 0 ? <Text color={THEME.muted}>‹ </Text> : null}
        {categories.slice(from0, from0 + 7).map((c, i) => (
          <Text key={c}>
            {from0 + i === catIdx ? <Text backgroundColor={THEME.prompts} color="#0d1117" bold>{` ${c.replace(/_/g, " ")} `}</Text> : <Text color={THEME.muted}>{` ${c.replace(/_/g, " ")} `}</Text>}
          </Text>
        ))}
        {from0 + 7 < categories.length ? <Text color={THEME.muted}> ›</Text> : null}
        <Text>  </Text>
        {coreOnly ? <Text backgroundColor={THEME.ok} color="#0d1117" bold>{" ★ core "}</Text> : <Text color={THEME.muted}>{" ★ core "}</Text>}
      </Text>
    </Box>
  );
  const picksNode = recommended ? (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text bold color={THEME.chat}>◆ codex picks</Text>
        {recommended.busy ? <Text color={THEME.chat}>{` ${"⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[frame % 10]} thinking…`}</Text> : null}
        <Text color={THEME.muted}>{` for “${recommended.task.slice(0, 50)}”`}</Text>
      </Text>
      {recommended.picks.length ? (
        <Text wrap="truncate-end">{recommended.picks.map((p, i) => <Text key={p.name}>{i ? "  " : ""}<Text backgroundColor={THEME.tagBg} color={THEME.prompts}>{` ${i + 1} ${p.name} `}</Text></Text>)}</Text>
      ) : null}
    </Box>
  ) : null;
  const t = list[sel];
  const filtered = !!query.trim() || catIdx > 0 || coreOnly;
  const head = query.trim() ? `${list.length} match${list.length === 1 ? "" : "es"} for “${query.trim()}”` : filtered ? `${list.length} of ${total} techniques` : `${total} techniques · ${from ?? ""}`;
  const listNode = (
    <Box flexDirection="column" width={listW} flexShrink={0} overflow="hidden" borderStyle="round" borderColor={THEME.muted} paddingX={1}>
      <Text wrap="truncate-end"><Text bold color={THEME.prompts}>{head}</Text>{filtered ? <Text color={THEME.muted}>{"  "}<Text backgroundColor={THEME.tagBg} color={THEME.note}>{" Esc ✕ filters "}</Text></Text> : null}</Text>
      {chips}
      {picksNode}
      {(() => {
        // rows = section headers + techniques; the window scrolls over rows, headers included
        const picks = new Set(recommended?.picks.map((p) => p.name) ?? []);
        const rowsOut: Array<{ head?: string; t?: Technique; i?: number }> = [];
        let lastCat = "";
        list.forEach((x, i) => {
          if (picks.has(x.name)) {
            if (i === 0) rowsOut.push({ head: "◆ CODEX PICKS" });
          } else if (!query.trim() || picks.size) {
            const cat = x.category.replace(/_/g, " ").toUpperCase();
            if (cat !== lastCat) rowsOut.push({ head: cat });
            lastCat = cat;
          }
          rowsOut.push({ t: x, i });
        });
        const selRow = rowsOut.findIndex((r) => r.i === sel);
        const fit = Math.max(3, listRows);
        const from = Math.max(0, Math.min(selRow - Math.floor(fit / 2), rowsOut.length - fit));
        // border + head + chips (+ codex picks) sit above the first row
        onRows?.(3 + picksRow, listW, rowsOut.slice(from, from + fit).map((r) => r.i));
        return rowsOut.slice(from, from + fit).map((r, k) => r.head ? (
          <Box key={`h${from + k}`} height={1} overflow="hidden"><Text color={r.head.startsWith("◆") ? THEME.chat : THEME.muted} bold={r.head.startsWith("◆")} wrap="truncate-end">{r.head}</Text></Box>
        ) : (
          <Box key={r.t!.name} height={1} overflow="hidden" backgroundColor={r.i === sel ? SELECTED_BG : undefined}>
            <Text wrap="truncate-end">
              {r.i === sel ? "▸ " : "  "}
              <Text bold color={picks.has(r.t!.name) ? THEME.chat : r.t!.tier === "core" ? THEME.prompts : THEME.text}>{r.t!.name}</Text>
              {r.t!.tier === "core" ? <Text color={THEME.prompts}> ★</Text> : null}
              <Text color={THEME.muted}>{`  ${r.t!.useWhen}`}</Text>
            </Text>
          </Box>
        ));
      })()}
    </Box>
  );
  const detailW = side ? width - listW - 1 : width;
  // fixed column widths: neither column may grow or shrink with its content
  const detail = t ? (
    <Box flexDirection="column" width={detailW} flexShrink={0} overflow="hidden" borderStyle="round" borderColor={THEME.prompts} paddingX={1}>
      <Text wrap="truncate-end">
        <Text bold color={THEME.you}>{t.name}</Text>
        {t.alias ? <Text color={THEME.muted}>{`  alias ${t.alias}`}</Text> : null}
        <Text>  </Text><Tag label={t.category.replace(/_/g, " ")} color={THEME.prompts} />
        {t.tier ? <Text> <Tag label={t.tier} color={t.tier === "core" ? THEME.ok : THEME.muted} /></Text> : null}
        {t.kind ? <Text> <Tag label={t.kind} color={THEME.chat} /></Text> : null}
      </Text>
      <Text> </Text>
      {wrap(t.description, detailW - 4).map((l, i) => <Text key={`d${i}`}>{l}</Text>)}
      <Text> </Text>
      {recommended?.picks.find((p) => p.name === t.name)?.why ? (
        <>
          <Text bold color={THEME.chat}>WHY (codex)</Text>
          {wrap(recommended.picks.find((p) => p.name === t.name)!.why, detailW - 4).map((l, i) => <Text key={`w${i}`}>{l}</Text>)}
          <Text> </Text>
        </>
      ) : null}
      <Text bold color={THEME.chat}>USE WHEN</Text>
      {wrap(t.useWhen, detailW - 4).map((l, i) => <Text key={`u${i}`}>{l}</Text>)}
      <Text> </Text>
      <Text bold color={THEME.ok}>EXAMPLE</Text>
      {wrap(t.example, detailW - 4).map((l, i) => <Text key={`e${i}`} color={THEME.muted}>{l}</Text>)}
      <Text> </Text>
      <Text color={THEME.muted} wrap="wrap">Enter → proposes to Claude: apply {t.name} to {query.trim() ? `“${query.trim()}”` : "your last question"} (you approve with ^S)</Text>
    </Box>
  ) : <Text color={THEME.muted}>no technique matches — try other words</Text>;
  return side ? <Box flexDirection="row" gap={1}>{listNode}{detail}</Box> : <Box flexDirection="column">{listNode}{detail}</Box>;
}

function App({ controller }: { controller: WatchController }) {
  const s = useSyncExternalStore(controller.subscribe, controller.getState);
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [input, setInput] = useState("");
  const [editing, setEditing] = useState(false);
  const [sel, setSel] = useState<number | null>(null); // null = follow newest
  // opens on the home page; Tab / arrows leave it, ^G comes back
  const [view, setView] = useState<View>("home");
  const [chatOff, setChatOff] = useState(0); // lines scrolled up from the bottom
  const pausedAt = useRef<number | null>(null);
  const escAt = useRef<{ at: number; view: View } | null>(null);
  const { stdout: appOut } = useStdout();
  const screenNow = () => screens.get(appOut) ?? [];
  const memMax = useRef(0);
  const memHeads = useRef<number[]>([]);
  const [memRaw, setMemRaw] = useState(false);
  // the header's real height (its status row comes and goes) — clicks map terminal rows through it
  const headerRef = useRef<DOMElement>(null);
  const headerH = useRef(3);
  useEffect(() => {
    if (headerRef.current) headerH.current = measureElement(headerRef.current).height;
  });
  // what each visible call-list row opens, by terminal row (1-based y) — filled at render
  const listClicks = useRef<{ top: number; targets: number[] }>({ top: 0, targets: [] });
  // PROMPTS / MEMORY lists: first row's offset inside the body, the list width, what each row selects
  const paneClicks = useRef<{ offset: number; width: number; targets: Array<number | undefined> }>({ offset: 0, width: 0, targets: [] });
  const onRows = (offset: number, w: number, targets: Array<number | undefined>) => { paneClicks.current = { offset, width: w, targets }; };
  const [toast, setToast] = useState<{ text: string; at: number } | null>(null);
  // links drawn in the MEMORY document: body row + column span → url (clicks open them in the browser)
  const linkZones = useRef<{ zones: Array<{ row: number; from: number; to: number; url: string }>; left: number }>({ zones: [], left: 0 });
  // select mode: the mouse goes back to the terminal (drag selects, ⌘-click opens links); ^X / Esc returns it
  const [selectMode, setSelectModeRaw] = useState(false);
  const selectAt = useRef(0);
  const SELECT_MS = 15_000; // select mode hands the mouse back by itself
  const setSelectMode = (v: boolean | ((p: boolean) => boolean)) => {
    setSelectModeRaw((p) => {
      const next = typeof v === "function" ? v(p) : v;
      if (next) selectAt.current = Date.now();
      return next;
    });
  };
  const pressAt = useRef<{ x: number; y: number } | null>(null);
  // a drag selects text in place: copied at once, and attached to the next question until Esc
  const [dragTo, setDragTo] = useState<{ x: number; y: number } | null>(null);
  const [attached, setAttached] = useState<string | null>(null);
  // solo chat: only your questions and the brain's answers — the brain's running notes hidden
  const [chatSolo, setChatSolo] = useState(false);
  // a long proposal is reviewed whole before it can be sent: the first ^S expands it
  const [reviewing, setReviewing] = useState<string | null>(null);
  // the open card's tab — every card opens on OUTPUT
  const [cardTab, setCardTab] = useState<CardTab>("OUTPUT");
  // pinned calls stay on top of the list (^P)
  const [starred, setStarred] = useState<Set<string>>(() => new Set());
  // compare: the call marked with ^O shows beside the open one
  const [compareKey, setCompareKey] = useState<string | null>(null);
  // MODELS tab carousel position
  const [modelIdx, setModelIdx] = useState(0);
  const reviewAt = useRef(0);
  const [, setFoldTick] = useState(0);
  const [memFolded, setMemFolded] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (!selectMode) return;
    const t = setTimeout(() => setSelectModeRaw(false), SELECT_MS);
    return () => clearTimeout(t);
  }, [selectMode]);
  const selectSeen = useRef(false);
  useEffect(() => {
    if (!selectSeen.current) { selectSeen.current = true; return; } // the first render: renderWatchUi already set the mouse up
    if (!s.mouse || !process.stdout.isTTY) return;
    process.stdout.write(selectMode ? MOUSE_OFF : MOUSE_ON);
  }, [selectMode, s.mouse]);
  const copy = (text: string, what: string) => {
    process.stdout.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
    setToast({ text: `✓ copied ${what} · ${text.length.toLocaleString()} chars`, at: Date.now() });
  };
  const [expanded, setExpanded] = useState(false); // "behind the scenes" open
  const [promptSel, setPromptSel] = useState(0);
  const [memSel, setMemSel] = useState(0);
  const [memOff, setMemOff] = useState(0);
  const [memFocus, setMemFocusRaw] = useState<"files" | "doc">("files");
  const setMemFocus = (f: "files" | "doc") => {
    if (f === memFocus) return;
    setMemFocusRaw(f);
    setFocusAt(Date.now());
  };
  const [catIdx, setCatIdx] = useState(0); // 0 = all categories
  const [coreOnly, setCoreOnly] = useState(false);
  useEffect(() => {
    if (view === "prompts") void controller.loadTechniques();
  }, [view]);
  // Claude used a prompt-technique tool: open PROMPTS on that technique, or filtered to its task
  const [pinned, setPinned] = useState<string | undefined>();
  useEffect(() => {
    const f = s.focusTechnique;
    if (!f || editing || (input && view !== "prompts")) return;
    setView("prompts");
    setCatIdx(0);
    setCoreOnly(false);
    setPromptSel(0);
    setPinned(f.name);
    setInput(f.name ? "" : (f.query ?? "").slice(0, 120));
  }, [s.focusTechnique?.ts]);

  // card scroll is remembered per call: going back to a call returns to where you were
  const [offsets, setOffsets] = useState<Record<string, number>>({});
  const [focusPane, setFocusPaneRaw] = useState<"list" | "card" | "chat">("card");
  // focus moves are animated: the newly focused border pulses for ~0.6s
  const [focusAt, setFocusAt] = useState(0);
  const setFocusPane = (f: "list" | "card" | "chat" | ((p: "list" | "card" | "chat") => "list" | "card" | "chat")) => {
    const next = typeof f === "function" ? f(focusPane) : f;
    if (next === focusPane) return;
    setFocusPaneRaw(next);
    setFocusAt(Date.now());
  };
  const cardMax = useRef(0);
  const [shownAt, setShownAt] = useState(0);
  useEffect(() => setShownAt(Date.now()), [s.proposal]);
  const [size, setSize] = useState({ rows: stdout.rows || 40, cols: stdout.columns || 80 });

  useEffect(() => {
    const onResize = () => setSize({ rows: stdout.rows || 40, cols: stdout.columns || 80 });
    stdout.on("resize", onResize);
    return () => void stdout.off("resize", onResize);
  }, [stdout]);

  // each tab keeps its own search: CALLS and CHAT never filter each other
  const [queries, setQueries] = useState<{ calls: string; chat: string }>({ calls: "", chat: "" });
  const qKey: "calls" | "chat" = view === "chat" ? "chat" : "calls";
  const query = queries[qKey];
  const setQuery = (f: string | ((q: string) => string)) =>
    setQueries((all) => ({ ...all, [qKey]: typeof f === "function" ? f(all[qKey]) : f }));
  // density: compact by itself below 28 rows; ^T overrides either way
  const [compactPref, setCompactPref] = useState<boolean | null>(null);
  const [help, setHelp] = useState(false); // ?: key help
  const [searching, setSearching] = useState(false);
  const allItems = useMemo(() => groupItems(s.cards), [s.cards]);
  const items = useMemo(() => filterItems(allItems, queries.calls), [allItems, queries.calls]);
  const calls = items.filter((i) => i.call);
  const idx = items.length === 0 ? -1 : sel === null ? followIndex(items) : Math.min(sel, items.length - 1);
  // a status line shows for 8s, then gives its row back
  const lastStatusCard = [...s.cards].reverse().find((c) => c.type === "status");
  const lastStatus = lastStatusCard && Date.now() - lastStatusCard.ts < STATUS_MS ? lastStatusCard : undefined;
  const [, setStatusTick] = useState(0);
  useEffect(() => {
    if (!lastStatus) return;
    const t = setTimeout(() => setStatusTick((n) => n + 1), STATUS_MS - (Date.now() - lastStatus.ts) + 50);
    return () => clearTimeout(t);
  }, [lastStatus?.key]);
  const answers = s.cards.filter((c) => c.type === "answer" && c.input && c.cite !== "sent");
  const chatCount = answers.length;
  // follow-ups of the latest answer, until you ask something else
  const followups = !s.asking && answers.length ? answers[answers.length - 1].followups ?? [] : [];
  const categories = useMemo(() => ["all", ...[...new Set((s.techniques ?? []).map((t) => t.category))].sort()], [s.techniques]);
  const ranked = useMemo(() => {
    if (view !== "prompts") return [];
    const cat = categories[catIdx] ?? "all";
    let list = rankTechniques(s.techniques ?? [], input).filter((t) => (cat === "all" || t.category === cat) && (!coreOnly || t.tier === "core"));
    // the technique Claude just used, then the brain's picks, go first
    if (pinned) {
      const pin = (s.techniques ?? []).find((t) => t.name === pinned || t.alias === pinned);
      if (pin) list = [pin, ...list.filter((t) => t !== pin)];
    }
    const picks = s.recommended?.picks.map((p) => p.name) ?? [];
    if (picks.length) list = [...picks.map((n) => (s.techniques ?? []).find((t) => t.name === n)!).filter(Boolean), ...list.filter((t) => !picks.includes(t.name))];
    return list;
  }, [view, s.techniques, input, catIdx, coreOnly, categories, s.recommended, pinned]);
  const technique: Technique | undefined = ranked[Math.min(promptSel, Math.max(0, ranked.length - 1))];
  const nowMs = Date.now();
  // animate while something runs, a note pulses, or an answer types itself in
  const anyRunning = s.reviewing || !!s.asking
    || s.cards.some((c) => (c.status === "running" && (c.via === "tachibot" || c.type === "span"))
      || (c.type === "note" && nowMs - c.ts < PULSE_MS)
      || (c.type === "answer" && nowMs - c.ts < TYPE_MS))
    || selectMode
    || nowMs - focusAt < 700
    || (!!toast && nowMs - toast.at < 2600);
  const frame = useFrame(anyRunning);
  // the pulse: bright → normal accent, 3 blinks over ~0.6s
  const pulsing = nowMs - focusAt < 650;
  const focusColor = (accent: string) => (pulsing && frame % 2 === 0 ? "#f0f6fc" : accent);
  const current = idx >= 0 ? items[idx] : undefined;
  // a long call that finishes: ring the terminal bell and say so in the footer
  const running = useRef(new Set<string>());
  useEffect(() => {
    for (const c of s.cards) {
      if (c.type !== "tool") continue;
      if (c.status === "running") { running.current.add(c.key); continue; }
      if (!running.current.has(c.key)) continue;
      running.current.delete(c.key);
      if ((c.ms ?? 0) < 60_000) continue;
      const took = `${Math.floor((c.ms ?? 0) / 60_000)}m${String(Math.round(((c.ms ?? 0) % 60_000) / 1000)).padStart(2, "0")}`;
      if (process.stdout.isTTY) process.stdout.write("\x07");
      setToast({ text: `${c.status === "error" ? "✗" : "✓"} ${c.title.replace(/^tachibot · /, "")} finished · ${took}`, at: Date.now() });
    }
  }, [s.cards]);

  // every card opens on OUTPUT
  const currentKey = current?.call?.key;
  useEffect(() => { setCardTab("OUTPUT"); setModelIdx(0); }, [currentKey]);
  const offKey = current?.call?.key ?? current?.loose?.key ?? "";
  const offset = offsets[offKey] ?? 0;
  const setOffset = (f: number | ((o: number) => number)) =>
    setOffsets((all) => ({ ...all, [offKey]: Math.max(0, typeof f === "function" ? f(all[offKey] ?? 0) : f) }));

  // following the newest call: reset scroll when a new one arrives
  const newestKey = idx >= 0 ? `${(items[idx].call ?? items[idx].loose)!.key}:${(items[idx].call ?? items[idx].loose)!.status}` : "";
  useEffect(() => {
    if (sel === null && current?.call) setOffsets((o) => ({ ...o, [current.call!.key]: 0 }));
  }, [newestKey, sel]);

  const rows = Math.max(14, size.rows - 1);
  const dense = compactPref ?? size.rows < 28;
  const width = Math.max(30, size.cols - 2);
  // ≥140 columns: list, card and chat side by side
  const wide = s.layout === "split" ? size.cols >= 90 : s.layout === "auto" && size.cols >= WIDE_COLS;
  // ≥140 cols: list · card · chat; narrower splits: list · card, chat on Tab.
  // Widths scale with the pane so the card always keeps most of the room.
  const threeCol = wide && size.cols >= WIDE_COLS;
  // three columns: the card is the reading pane, so it gets the most (list ≈ 26%, chat ≈ 26%)
  const listW = threeCol ? Math.max(34, Math.min(LIST_W, Math.floor(size.cols * 0.26))) : Math.max(28, Math.min(52, Math.floor(size.cols * 0.32)));
  const chatW = threeCol ? Math.max(34, Math.min(CHAT_W, Math.floor(size.cols * 0.26))) : 0;
  const cardW = size.cols - listW - chatW - (threeCol ? 4 : 3);
  // the proposal is what you approve: 3 lines visible (never 1), the rest via ctrl+e
  const proposalLines = s.proposal ? wrap(s.proposal, width - 4) : [];
  // under review the box shows every line (proposals are capped, so they fit); else 3 lines
  const reviewRoom = Math.max(3, rows - 14);
  const reviewFits = proposalLines.length <= reviewRoom;
  const proposalShown = reviewing && reviewing === s.proposal ? (reviewFits ? proposalLines : [...proposalLines.slice(0, reviewRoom - 1), "… too long for this pane — ^E to read it whole"])
    : proposalLines.length > 3 ? [...proposalLines.slice(0, 2), `${proposalLines[2].slice(0, Math.max(0, width - 26))}… (^S: read all)`] : proposalLines;
  const proposalRows = s.proposal ? 3 + proposalShown.length : 0;
  // the input wraps onto up to 3 lines (the newest text stays visible)
  const promptLabel = editing ? "edit › " : view === "prompts" ? "task › " : view === "memory" ? "ask › " : s.asking ? "ask (answering…) › " : view === "chat" ? "ask › " : view === "home" ? "ask › " : "ask about this call › ";
  const wrappedInput = wrap(input.replace(/\n/g, " ⏎ ") || " ", Math.max(10, size.cols - promptLabel.length - 2));
  const inputLines = wrappedInput.slice(-3);
  const bodyRows = rows - (lastStatus ? 4 : 3) /* header */ - inputLines.length - 1 /* hints */ - ((searching || query) && (view === "calls" || view === "chat") ? 1 : 0) - proposalRows - (attached ? 1 : 0);

  const page = Math.max(4, bodyRows - 6);
  // --- keys: one ordered stack of layers. The first layer that handles a key consumes it,
  // so a tab never sees a key an overlay, the proposal or search already took.
  type Layer = (ch: string, key: Key) => boolean;
  const did = (fn: () => void): true => {
    fn();
    return true;
  };
  const typing = !!input || editing;

  const quitLayer: Layer = (ch, key) => key.ctrl && ch === "c" && did(exit);

  // approval needs a deliberate key — bare letters always go to the input
  const proposalLayer: Layer = (ch, key) => {
    if (!s.proposal || editing) return false;
    // a proposal longer than its 3 visible lines is never sent unseen: the first ^S opens it whole
    if (key.ctrl && ch === "s") return did(() => {
      if (Date.now() - shownAt <= 1000) return;
      if (proposalLines.length > 3 && reviewing !== s.proposal) { reviewAt.current = Date.now(); setReviewing(s.proposal!); return; }
      // the expanded text must actually fit, and be on screen a moment, before ^S sends it
      if (reviewing === s.proposal && (!reviewFits || Date.now() - reviewAt.current < 900)) return;
      setReviewing(null);
      controller.send(s.proposal!);
    });
    if (key.escape && !input) return did(() => controller.cancelProposal());
    if (key.ctrl && ch === "e") return did(() => { setEditing(true); setInput(s.proposal!); });
    return false;
  };

  // the help overlay owns every key while open
  const helpLayer: Layer = (ch, key) => help && did(() => (key.escape || ch === "?") && setHelp(false));

  const globalLayer: Layer = (ch, key) => {
    if (key.ctrl && ch === "x") return did(() => setSelectMode((v) => !v));
    if (key.ctrl && ch === "n" && (view === "chat" || threeCol)) return did(() => setChatSolo((v) => !v));
    // ^P pins / unpins the open call · ^K exports it as markdown
    if (key.ctrl && ch === "p" && current?.call) {
      const k = current.call.key;
      return did(() => {
        setStarred((p) => { const n = new Set(p); n.has(k) ? n.delete(k) : n.add(k); return n; });
        setToast({ text: starred.has(k) ? "☆ unpinned" : "★ pinned — it stays on top of the list", at: Date.now() });
      });
    }
    if (key.ctrl && ch === "k" && current?.call) {
      const c = current.call;
      return did(() => {
        try {
          const tool = c.title.replace(/^tachibot · /, "");
          const stamp = new Date(c.ts).toISOString().slice(0, 16).replace(/[T:]/g, "-");
          const dir = fs.existsSync(`${s.cwd}/dokoro/daily`) ? `${s.cwd}/dokoro/daily` : `${s.cwd}/.tachi/exports`;
          fs.mkdirSync(dir, { recursive: true });
          const file = `${dir}/${stamp}-${tool}.md`;
          const body = `---\ntool: ${tool}\nstatus: ${c.status}\ndate: ${new Date(c.ts).toISOString()}\n---\n\n# ${tool}\n\n## Input\n\n${c.inputFull ?? c.input ?? ""}\n\n## Output\n\n${visibleOf(c.fullAnsi ?? c.full ?? c.output ?? "")}\n`;
          fs.writeFileSync(file, body);
          copy(file, "the export path");
          setToast({ text: `→ exported ${file.replace(`${s.cwd}/`, "")} · path copied`, at: Date.now() });
        } catch (e) {
          setToast({ text: `✗ export failed: ${(e as Error).message}`, at: Date.now() });
        }
      });
    }
    if (ch === "?" && !typing && !searching) return did(() => setHelp(true));
    if (key.ctrl && ch === "t") return did(() => setCompactPref(!dense));
    if (key.ctrl && ch === "g") return did(() => setView("home"));
    // ^Y copies what you are looking at: the open call's output, the memory file, the last answer
    if (key.ctrl && ch === "y" && view !== "prompts") {
      if (view === "memory") {
        const f = s.memoryList[Math.min(memSel, Math.max(0, s.memoryList.length - 1))];
        if (!f) return true;
        const abs = f.startsWith("~") ? f.replace("~", homedir()) : `${s.cwd}/${f}`;
        try { const text = fs.readFileSync(abs, "utf8"); return did(() => copy(text, f.split("/").pop()!)); } catch { return true; }
      }
      if (view === "chat") {
        const last = [...s.cards].reverse().find((c) => c.type === "answer" && c.output);
        return last ? did(() => copy(last.output!, "the last answer")) : true;
      }
      const c = current?.call;
      const text = c ? (c.full ?? c.output ?? "") : "";
      return text ? did(() => copy(text, `${c!.tool ?? "call"} output`)) : true;
    }
    if (key.ctrl && ch === "b") {
      return did(() => (current?.call && !current.models.length ? controller.handleLine("/note-models") : setExpanded((e) => !e)));
    }
    if (key.ctrl && ch === "f") {
      // ^F searches the tab you're on: PROMPTS ranks by its task line, so there it clears that line
      if (view === "prompts") return did(() => { setInput(""); setPromptSel(0); });
      return did(() => { if (view === "home") setView("calls"); setSearching(true); setSel(null); });
    }
    if (key.tab) {
      return did(() => {
        setChatOff(0);
        if (view === "home") {
          // entering the calls from home always lands on the newest one
          setSel(null);
        }
        // Tab forward, Shift+Tab back — a ring
        const ring: View[] = ["home", "calls", "chat", "prompts", "memory"];
        setView((v) => ring[(ring.indexOf(v) + (key.shift ? ring.length - 1 : 1)) % ring.length]);
      });
    }
    return false;
  };

  const searchLayer: Layer = (ch, key) => {
    if (searching) {
      if (key.escape) return did(() => { setSearching(false); setQuery(""); });
      if (key.return) return did(() => setSearching(false));
      if (key.backspace || key.delete) return did(() => setQuery((q) => q.slice(0, -1)));
      if (ch && !key.ctrl && !key.meta && !key.upArrow && !key.downArrow) return did(() => setQuery((q) => q + ch.replace(/[\x00-\x1f\x7f]/g, "")));
      return false;
    }
    // a kept filter: the first Esc clears it
    return key.escape && !!query && !input && did(() => setQuery(""));
  };

  const askSuggestion: Layer = (ch) =>
    !typing && /^[1-3]$/.test(ch) && did(() => { setView("chat"); controller.handleLine(START_SUGGESTIONS[Number(ch) - 1]); });
  const askFollowUp: Layer = (ch) =>
    !typing && /^[1-3]$/.test(ch) && !!followups[Number(ch) - 1] && did(() => { setChatOff(0); controller.handleLine(followups[Number(ch) - 1], current?.call?.key); });

  // each tab's own keys
  const tabLayers: Record<View, Layer> = {
    home: (ch, key) => {
      if ((key.upArrow || key.downArrow) && items.length) return did(() => { setSel(null); setView("calls"); });
      return askSuggestion(ch, key);
    },
    calls: (ch, key) => {
      if (!typing && cardTab === "MODELS" && (ch === "[" || ch === "]")) return did(() => { setModelIdx((n) => n + (ch === "]" ? 1 : -1)); setOffset(0); });
      if (key.ctrl && ch === "o" && current?.call) {
        const k = current.call.key;
        return did(() => {
          setCompareKey((c) => (c === k ? null : k));
          setToast({ text: compareKey === k ? "compare off" : "⇆ marked — open another call to compare them side by side · Esc ends", at: Date.now() });
        });
      }
      if (!items.length && askSuggestion(ch, key)) return true;
      if (wide && askFollowUp(ch, key)) return true;
      // split: ←/→ move focus between list, card (and chat); keys act on the focused pane
      if (wide && (key.leftArrow || key.rightArrow)) {
        const panes: Array<"list" | "card" | "chat"> = threeCol ? ["list", "card", "chat"] : ["list", "card"];
        return did(() => setFocusPane((f) => panes[Math.max(0, Math.min(panes.length - 1, panes.indexOf(f) + (key.rightArrow ? 1 : -1)))]));
      }
      const pane = wide ? focusPane : "list";
      const top = !typing && ch === "g";
      const end = !typing && ch === "G";
      if (pane === "chat") {
        if (key.upArrow) return did(() => setChatOff((o) => o + 1));
        if (key.downArrow) return did(() => setChatOff((o) => Math.max(0, o - 1)));
        if (key.pageUp || (key.ctrl && ch === "u")) return did(() => setChatOff((o) => o + page));
        if (key.pageDown || (key.ctrl && ch === "d")) return did(() => setChatOff((o) => Math.max(0, o - page)));
        if (top) return did(() => setChatOff(1e6));
        if (end) return did(() => setChatOff(0));
        return false;
      }
      if (pane === "card") {
        if (key.upArrow) return did(() => setOffset((o) => Math.max(0, o - 1)));
        if (key.downArrow) return did(() => setOffset((o) => Math.min(cardMax.current, o + 1)));
        if (top) return did(() => setOffset(0));
        if (end) return did(() => setOffset(cardMax.current));
      } else {
        if (key.upArrow) return did(() => setSel(Math.max(0, (idx < 0 ? 0 : idx) - 1)));
        if (key.downArrow) return did(() => setSel(idx + 1 >= items.length ? null : idx + 1));
        if (top) return did(() => setSel(0));
        if (end) return did(() => setSel(null));
      }
      if (key.pageDown || (key.ctrl && ch === "d")) return did(() => setOffset((o) => Math.min(cardMax.current, o + page)));
      if (key.pageUp || (key.ctrl && ch === "u")) return did(() => setOffset((o) => Math.max(0, o - page)));
      return false;
    },
    chat: (ch, key) => {
      if (askFollowUp(ch, key)) return true;
      if (key.upArrow) return did(() => setChatOff((o) => o + 1));
      if (key.downArrow) return did(() => setChatOff((o) => Math.max(0, o - 1)));
      if (key.pageUp || (key.ctrl && ch === "u")) return did(() => setChatOff((o) => o + page));
      if (key.pageDown || (key.ctrl && ch === "d")) return did(() => setChatOff((o) => Math.max(0, o - page)));
      return false;
    },
    memory: (ch, key) => {
      const n = s.memoryList.length;
      // ^O: jump to the next heading (wraps to the top) · ^R: raw markdown ⇄ reader
      if (key.ctrl && ch === "o") return did(() => { setMemFocus("doc"); setMemOff((o) => Math.min(memMax.current, memHeads.current.find((h) => h > o) ?? 0)); });
      if (key.ctrl && ch === "r") return did(() => { setMemRaw((r) => !r); setMemOff(0); });
      // ←/→: file list | document; ↑↓ act on the focused side
      if (key.leftArrow) return did(() => setMemFocus("files"));
      if (key.rightArrow || (key.return && !typing && memFocus === "files")) return did(() => setMemFocus("doc"));
      if (memFocus === "doc") {
        if (key.upArrow) return did(() => setMemOff((o) => Math.max(0, o - 1)));
        if (key.downArrow) return did(() => setMemOff((o) => Math.min(memMax.current, o + 1)));
        if (!typing && ch === "G") return did(() => setMemOff(memMax.current));
      } else {
        if (key.upArrow) return did(() => { setMemSel((i) => Math.max(0, i - 1)); setMemOff(0); });
        if (key.downArrow) return did(() => { setMemSel((i) => Math.min(Math.max(0, n - 1), i + 1)); setMemOff(0); });
        if (!typing && ch === "G") return did(() => { setMemSel(Math.max(0, n - 1)); setMemOff(0); });
      }
      if (key.pageDown || (key.ctrl && ch === "d")) return did(() => setMemOff((o) => Math.min(memMax.current, o + page)));
      if (key.pageUp || (key.ctrl && ch === "u")) return did(() => setMemOff((o) => Math.max(0, o - page)));
      if (!typing && ch === "g") return did(() => setMemOff(0));
      return false;
    },
    prompts: (ch, key) => {
      if (editing) return false;
      if (key.upArrow) return did(() => setPromptSel((n) => Math.max(0, n - 1)));
      if (key.downArrow) return did(() => setPromptSel((n) => Math.min(Math.max(0, ranked.length - 1), n + 1)));
      if (key.leftArrow) return did(() => { setPromptSel(0); setCatIdx((i) => (i - 1 + categories.length) % categories.length); });
      if (key.rightArrow) return did(() => { setPromptSel(0); setCatIdx((i) => (i + 1) % categories.length); });
      if (key.ctrl && ch === "o") return did(() => { setPromptSel(0); setCoreOnly((c) => !c); });
      if (key.ctrl && ch === "r") return did(() => { setPromptSel(0); void controller.recommendTechniques(input); });
      if (key.ctrl && ch === "y" && technique) {
        // OSC 52: the technique name onto the system clipboard (Ghostty, iTerm2, kitty, wezterm)
        return did(() => process.stdout.write(`\x1b]52;c;${Buffer.from(technique.name).toString("base64")}\x07`));
      }
      if (key.return) return did(() => { if (technique) controller.proposeTechnique(technique, input); setInput(""); });
      if (key.escape) {
        // one key turns every filter off: task text, category, core-only, pin
        return did(() => { setInput(""); setPromptSel(0); setCatIdx(0); setCoreOnly(false); setPinned(undefined); });
      }
      if (key.backspace || key.delete) return did(() => { setPromptSel(0); setInput((v) => v.slice(0, -1)); });
      if (ch && !key.ctrl && !key.meta) return did(() => { setPromptSel(0); setInput((v) => v + ch.replace(/[\x00-\x1f\x7f]/g, "")); });
      return false;
    },
  };

  // the ask input: Esc, Enter, editing, typing
  const inputLayer: Layer = (ch, key) => {
    if (key.escape) {
      // Esc backs out one layer: typed text first, then the tab itself (→ HOME)
      if (typing) return did(() => { setInput(""); setEditing(false); });
      escAt.current = { at: Date.now(), view };
      return did(() => view !== "home" && setView("home"));
    }
    if (key.return) {
      return did(() => {
        let line = input;
        setInput("");
        if (attached && line.trim() && !line.trim().startsWith("/")) {
          // the selected text travels with the question (or with @claude … to Claude)
          const quote = `[selected text]\n"""\n${attached.slice(0, 6000)}\n"""\n`;
          line = line.trim().startsWith("@claude") ? line.replace(/^\s*@claude\s*/, `@claude ${quote}`) : `${quote}${line}`;
          setAttached(null);
        }
        if (editing) {
          setEditing(false);
          if (line.trim()) controller.send(line.trim());
          else controller.cancelProposal();
          return;
        }
        // a question (not a command) opens the conversation, where its answer appears
        if (line.trim() && (!line.trim().startsWith("/") || line.trim().startsWith("/send "))) {
          setView("chat");
          setChatOff(0);
        }
        if (!controller.handleLine(line, current?.call?.key)) exit();
      });
    }
    if (key.backspace || key.delete) return did(() => setInput((v) => v.slice(0, -1)));
    // a paste arrives as one chunk with \r line ends — keep it as text, never as cursor moves
    if (ch && !key.ctrl && !key.meta) return did(() => setInput((v) => v + ch.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")));
    return false;
  };

  // mouse wheel (SGR reports "[<64;x;yM" up / "[<65;x;yM" down): scroll what is under the pointer
  const mouseLayer: Layer = (ch) => {
    const m = /^\x1b?\[<(\d+);(\d+);(\d+)[Mm]/.exec(ch);
    if (!m) return false;
    // a mouse report whose ESC byte arrived alone was read as an Esc keypress — undo that Esc
    if (escAt.current && Date.now() - escAt.current.at < 300) {
      const back = escAt.current.view;
      escAt.current = null;
      setView(back);
    }
    const btn = Number(m[1]);
    const x = Number(m[2]);
    const y = Number(m[3]);
    if (btn === 0 && m[0].endsWith("M")) pressAt.current = { x, y };
    if (btn === 32) return pressAt.current ? did(() => setDragTo({ x, y })) : true; // dragging with the left button
    if (btn === 0 && m[0].endsWith("m")) {
      // press here, release there = a selection: copy it, attach it to the next question
      const p = pressAt.current;
      pressAt.current = null;
      setDragTo(null);
      if (p && (Math.abs(p.x - x) >= 2 || p.y !== y)) {
        const text = selectText(screenNow(), p, { x, y });
        if (!text) return true;
        return did(() => { setAttached(text); copy(text, "the selection"); });
      }
      return true;
    }
    // a click on a link in the MEMORY document opens it in the browser
    if (btn === 0 && view === "memory") {
      const lz = linkZones.current;
      const row = y - (headerH.current + 1) - 2;
      const col = x - lz.left - 1;
      const hit = lz.zones.find((z) => z.row === row && col >= z.from && col < z.to);
      if (hit) return did(() => { openUrl(hit.url); setToast({ text: `↗ opened in ${process.env.TACHI_BROWSER ?? "Chrome"} · ${hit.url.slice(0, 60)}`, at: Date.now() }); });
    }
    // a click on an accordion header toggles it: a card section, "behind the scenes", a MEMORY group
    if (btn === 0 && m[0].endsWith("M")) {
      const row = screenNow()[y - 1] ?? "";
      const at = (re: RegExp) => { const h = re.exec(row); return h && Math.abs(x - 1 - Array.from(row.slice(0, h.index)).length) < 40 ? h : null; };
      const sec = at(/[▾▸] (STEPS|INPUT|OUTPUT)\b/);
      if (sec) return did(() => { foldedSections.has(sec[1]) ? foldedSections.delete(sec[1]) : foldedSections.add(sec[1]); setFoldTick((t) => t + 1); });
      if (at(/[▾▸] behind the scenes/)) return did(() => setExpanded((e) => !e));
      for (const t of ["OUTPUT", "INPUT", "MODELS"] as CardTab[]) {
        const h = new RegExp(` ${t}(?: \\d+)? `).exec(row);
        if (!h) continue;
        const from = Array.from(row.slice(0, h.index)).length + 1;
        if (x >= from && x <= from + h[0].length - 1) return did(() => { setCardTab(t); setOffset(0); });
      }
      const car = /◂ \d+ \/ \d+ ▸/.exec(row);
      if (car) {
        const from = Array.from(row.slice(0, car.index)).length + 1;
        const w0 = Array.from(car[0]).length;
        if (x >= from && x < from + 3) return did(() => { setModelIdx((n) => n - 1); setOffset(0); });
        if (x > from + w0 - 4 && x <= from + w0) return did(() => { setModelIdx((n) => n + 1); setOffset(0); });
      }
      const tagAt = /( SOLO | ALL ) \^N/.exec(row);
      if (tagAt && Math.abs(x - 1 - Array.from(row.slice(0, tagAt.index)).length - 3) <= 4) return did(() => setChatSolo((v) => !v));
      const grp = view === "memory" ? at(/[▾▸] (PROJECT|CLAUDE MEMORY|DOKORO)\b/) : null;
      if (grp) return did(() => setMemFolded((f) => { const n = new Set(f); n.has(grp[1]) ? n.delete(grp[1]) : n.add(grp[1]); return n; }));
    }
    // a left click (press) focuses the pane under the pointer; other clicks/drags are swallowed
    if (btn === 0 && m[0].endsWith("M") && Number(m[3]) === headerH.current) {
      // the tab bar: click a tab to open it
      const hit = tabSpans(calls.length, chatCount, s.techniques?.length, s.memoryList.length).find((t) => x >= t.from && x <= t.to);
      return hit ? did(() => { setHelp(false); setView(hit.view); }) : true;
    }
    if (btn === 0 && m[0].endsWith("M")) {
      const bodyTop = headerH.current + 1;
      const pc = paneClicks.current;
      const row = Number(m[3]) - bodyTop - pc.offset;
      const target = x <= pc.width + 1 && row >= 0 ? pc.targets[row] : undefined;
      if (KEYLOG) fs.appendFileSync(KEYLOG, JSON.stringify({ click: { x, y: Number(m[3]), bodyTop, row, target, pc, lastStatus: !!lastStatus } }) + "\n");
      if (view === "memory") {
        const memListW = Math.max(30, Math.min(48, Math.floor((size.cols - 1) * 0.34)));
        return did(() => {
          setMemFocus(x <= memListW + 1 ? "files" : "doc");
          if (target !== undefined) { setMemSel(target); setMemOff(0); }
        });
      }
      if (view === "prompts") return target !== undefined ? did(() => setPromptSel(target)) : true;
      if (wide && view !== "chat" && view !== "home") {
        const pane = x <= listW + 1 ? "list" : threeCol && x > size.cols - chatW - 1 ? "chat" : "card";
        // clicking a call opens it; clicking a question header opens that question
        const target = pane === "list" ? listClicks.current.targets[Number(m[3]) - headerH.current - 1 - listClicks.current.top] : undefined;
        return did(() => {
          setFocusPane(pane);
          if (target !== undefined) setSel(target >= items.length - 1 ? null : target);
        });
      }
      return true;
    }
    if (btn !== 64 && btn !== 65) return true;
    const dir = btn === 64 ? -1 : 1;
    const step = 3;
    // which region: in the split, list | card | chat by column; otherwise the current tab
    const region = view === "memory" ? "memory" : wide && view !== "chat" && view !== "prompts" && view !== "home"
      ? x <= listW + 1 ? "list" : threeCol && x > size.cols - chatW - 1 ? "chat" : "card"
      : view === "chat" ? "chat" : view === "prompts" ? "prompts" : view === "calls" ? "card" : "none";
    if (region === "list") return did(() => { setSel(dir < 0 ? Math.max(0, (idx < 0 ? 0 : idx) - 1) : idx + 1 >= items.length ? null : idx + 1); });
    if (region === "card") return did(() => setOffset((o) => Math.max(0, o + dir * step)));
    if (region === "chat") return did(() => setChatOff((o) => Math.max(0, o - dir * step)));
    if (region === "memory") {
      // MEMORY: wheel over the file list picks files, over the document scrolls it
      const memListW = Math.max(30, Math.min(48, Math.floor((size.cols - 1) * 0.34)));
      if (x <= memListW + 1) return did(() => { setMemFocus("files"); setMemSel((i) => Math.min(Math.max(0, s.memoryList.length - 1), Math.max(0, i + dir))); setMemOff(0); });
      return did(() => { setMemFocus("doc"); setMemOff((o) => Math.min(memMax.current, Math.max(0, o + dir * step))); });
    }
    if (region === "prompts") return did(() => setPromptSel((n) => Math.min(Math.max(0, ranked.length - 1), Math.max(0, n + dir))));
    return true;
  };

  // select mode: Esc returns the mouse to the pane before anything else sees the key
  const selectLayer: Layer = (_ch, key) =>
    compareKey && key.escape && !input ? did(() => setCompareKey(null))
      : selectMode && key.escape ? did(() => setSelectMode(false))
      : attached && key.escape ? did(() => setAttached(null))
      : false;
  const LAYERS: Layer[] = [selectLayer, mouseLayer, quitLayer, proposalLayer, helpLayer, globalLayer, searchLayer, (ch, key) => tabLayers[view](ch, key), inputLayer];
  useInput((ch, key) => {
    if (KEYLOG) fs.appendFileSync(KEYLOG, JSON.stringify({ ch, key: Object.fromEntries(Object.entries(key).filter(([, v]) => v)) }) + "\n");
    for (const layer of LAYERS) if (layer(ch, key)) return;
  });

  // --- the three pieces: call list, open call card, chat ----------------------
  const chatNode = (w: number, room: number): ReactNode => {
    // the search filters the chat only when CHAT is the tab you searched in (not the side column)
    const words = queries.chat.toLowerCase().split(/\s+/).filter(Boolean);
    const chatCards = s.cards.filter((c) => (c.type === "answer" || (c.type === "note" && !chatSolo)) && (!words.length || words.every((x) => `${c.input ?? ""} ${c.output ?? ""} ${c.cite ?? ""}`.toLowerCase().includes(x))));
    const allRaw = chatLines(chatCards, s.asking, w - 1, nowMs);
    // compact: no spacer lines, no running "now" commentary
    const all = dense ? allRaw.filter((l) => l.text !== "" && !l.text.startsWith("◌") && !/^\s*\+\d+ earlier/.test(l.text)) : allRaw;
    // paused (scrolled up): remember where you were; count what arrived since
    if (chatOff === 0) pausedAt.current = null;
    else if (pausedAt.current === null) pausedAt.current = all.length;
    const fresh = chatOff > 0 && pausedAt.current !== null ? Math.max(0, all.length - pausedAt.current) : 0;
    // one spare row: the newest message must never be the one that gets clipped
    const fit = room - 2 - (followups.length && !chatOff ? followups.length + 2 : 0);
    const maxOff = Math.max(0, all.length - fit);
    const off = Math.min(chatOff, maxOff);
    const shown = all.slice(Math.max(0, all.length - fit - off), all.length - off);
    return (
      <Box flexDirection="column" flexGrow={1} justifyContent="flex-end">
        {off ? (
          <Text wrap="truncate-end">
            <Text color={THEME.note}>⏸ paused</Text>
            <Text dimColor>{` · ↑ ${maxOff - off} earlier · `}</Text>
            {fresh ? <Text color={THEME.chat} bold>{`↓ ${fresh} new`}</Text> : <Text dimColor>↓/PgDn newer</Text>}
          </Text>
        ) : <Text dimColor wrap="truncate-end">{maxOff ? `conversation · ↑/PgUp for ${maxOff} earlier lines` : "conversation"}</Text>}
        {shown.map((l, i) => (
          <Text key={i} wrap="truncate-end">
            {l.bar ? <Text color={l.bar}>▎ </Text> : null}
            {l.bg
              ? <Text backgroundColor={l.bg} color={l.color} bold={l.bold}>{(l.text + " ".repeat(Math.max(0, w - 2 - stringWidth(l.text))))}</Text>
              : l.ansi ? l.text || " " : <Text color={l.color} bold={l.bold} dimColor={l.dim}>{l.text || " "}</Text>}
          </Text>
        ))}
        {followups.length && !off ? (
          <Box flexDirection="column" marginTop={1}>
            <FollowUps items={followups} width={w} />
          </Box>
        ) : null}
      </Box>
    );
  };

  const cardNode = (it: Item, w: number, room: number, padLeft = 1): ReactNode => {
    if (it.loose) {
      return (
        <Box flexDirection="column" paddingLeft={1}>
          {(it.group ?? [it.loose])
            // callouts, like the design: source label, then the note in a softer tone; "now" commentary dimmed
            .flatMap((n, k) => {
              const now = n.cite === "now";
              const bar = now ? THEME.muted : THEME.note;
              return [
                ...(k ? [{ text: "", bar }] : []),
                { text: (n.cite ?? "note").toUpperCase(), bar, bold: true, color: bar },
                ...wrap(n.output ?? "", w - 4).map((t) => ({ text: t, bar, color: now ? THEME.muted : "#e6d3a3" })),
              ];
            })
            .slice(-Math.max(3, room))
            .map((l, i) => (
              <Text key={i} wrap="truncate-end"><Text color={l.bar}>▎ </Text><Text color={"color" in l ? l.color : undefined} bold={"bold" in l && l.bold}>{l.text || " "}</Text></Text>
            ))}
        </Box>
      );
    }
    const c = it.call!;
    const detailRoom = Math.max(4, room - 4 - (wide ? 1 : 0));
    // the judge that closes a council opens as the Council panel, its full answer below
    const council = /gemini_judge$/.test(c.title) && c.status !== "running"
      ? councilPanel(allItems.filter((x) => x.call).map((x) => ({ tool: x.call!.title, status: x.call!.status, ts: x.call!.ts, ms: x.call!.ms, input: x.call!.inputFull ?? x.call!.input, output: x.call!.full ?? x.call!.output, cite: x.call!.cite })),
          { tool: c.title, status: c.status, ts: c.ts, ms: c.ms, input: c.inputFull ?? c.input, output: c.full ?? c.output }, w - 4)
      : [];
    const detailAll = council.length
      ? [...council.map((text): Line => ({ text, ansi: true })), { text: "" } as Line, ...detailFor(it, w - 4, s.reviewingKey === c.key, expanded, modelIdx)]
      : detailFor(it, w - 4, s.reviewingKey === c.key, expanded, modelIdx);
    // tabs: the card shows one part at a time; it opens on OUTPUT
    const byTab = tabLines(detailAll);
    const tabCounts: Record<CardTab, number> = { OUTPUT: 0, INPUT: byTab.INPUT.filter((l) => l.text.trim() && !l.section).length, MODELS: it.models.length };
    const tabsShown = (["OUTPUT", "INPUT", "MODELS"] as CardTab[]).filter((t) => t === "OUTPUT" || byTab[t].length);
    const activeTab = tabsShown.includes(cardTab) ? cardTab : "OUTPUT";
    const tabBody = byTab[activeTab].filter((l) => !l.section || l.section === "STEPS"); // the tab names the part
    const detail = dense ? tabBody.filter((l) => l.text !== "") : tabBody;
    // a CALLS search marks its matches in the open card
    const hitWords = queries.calls.trim() ? queries.calls.trim().split(/\s+/).filter((x) => x.length > 1) : [];
    const maxOffset = Math.max(0, detail.length - detailRoom);
    cardMax.current = maxOffset;
    const off = Math.min(offset, maxOffset);
    // scrolled: a bar on top says what is above, so the card never looks like it starts mid-text
    const above = off > 0;
    const shown = detail.slice(off, off + detailRoom - (detail.length > detailRoom ? 1 : 0) - (above ? 1 : 0));
    return (
      <Box flexDirection="column" width={w} flexShrink={0} paddingLeft={padLeft} paddingRight={1} borderStyle={wide && focusPane === "card" ? "bold" : "round"} borderColor={wide && focusPane === "card" ? focusColor(cardColor(c.status)) : wide ? "#3d4a5c" : cardColor(c.status)}>
        {wide ? (focusPane === "card"
          ? <Text wrap="truncate-end"><Text backgroundColor={cardColor(c.status)} color="#0d1117" bold>{" CARD "}</Text><Text color={THEME.muted}> focused · ↑↓ line · PgUp/Dn page · g/G</Text></Text>
          : <Text wrap="truncate-end"><Text backgroundColor={THEME.tagBg} color={cardColor(c.status)} bold>{" CARD "}</Text><Text color={THEME.muted}> click or → to scroll it</Text></Text>) : null}
        <CardHeader
          icon={c.status === "running" ? <Spinner frame={frame} color="#e3b341" /> : ICON[c.status].icon}
          iconColor={ICON[c.status].color}
          title={c.title.replace(/^tachibot · /, "")}
          tags={[
            { label: c.status, color: ICON[c.status].color },
            ...(c.ms !== undefined ? [{ label: `${(c.ms / 1000).toFixed(1)}s`, color: "#f0f6fc" }] : []),
            ...tokenTags(it),
            ...(c.status === "running" ? [{ label: gauge(nowMs - c.ts, toolTimeoutMs(c.title)), color: "#e3b341" }] : []),
            ...[...new Set(it.models.filter((m) => m.type !== "thought").map((m) => shortModel(m.title)))].slice(0, 4).map((m) => ({ label: m, color: "#56d364" })),
            ...(it.notes.some((n) => n.type === "note") ? [{ label: `● ${it.notes.filter((n) => n.type === "note").length}`, color: "#e3b341" }] : []),
            ...(c.cite ? [{ label: `↳ ${c.cite}`, color: "#e3b341" }] : []),
            ...(confidenceMeter(c.full ?? c.output ?? "") ? [{ label: confidenceMeter(c.full ?? c.output ?? "")!, color: "#e3b341" }] : []),
          ]}
        />
        <Text wrap="truncate-end">
          {tabsShown.map((t) => (
            <Text key={t}>
              {t === activeTab
                ? <Text backgroundColor={cardColor(c.status)} color="#0d1117" bold>{` ${t}${tabCounts[t] ? ` ${tabCounts[t]}` : ""} `}</Text>
                : <Text backgroundColor={THEME.tagBg} color={THEME.muted}>{` ${t}${tabCounts[t] ? ` ${tabCounts[t]}` : ""} `}</Text>}
              <Text> </Text>
            </Text>
          ))}
        </Text>
        {above ? <Text color="#79c0ff" wrap="truncate-end">{`↑ ${off} lines above — PgUp`}</Text> : null}
        {shown.map((l, i) => (
          <Text key={i} wrap="truncate-end">
            {l.bar ? <Text color={l.bar}>▎ </Text> : null}
            {l.ansi ? highlightAnsi(l.text, hitWords) || " " : <Text color={l.color} bold={l.bold} dimColor={l.dim}>{highlightAnsi(l.text, hitWords) || " "}</Text>}
          </Text>
        ))}
        {detail.length > detailRoom ? (
          <Text wrap="truncate-end">
            <Text color="#79c0ff">{off < maxOffset ? `↓ ${maxOffset - off} more lines — PgDn` : "— end — PgUp to scroll back"}</Text>
            <Text color={THEME.muted}>{`   lines ${off + 1}–${Math.min(detail.length, off + shown.length)} of ${detail.length}`}</Text>
          </Text>
        ) : null}
      </Box>
    );
  };

  // a council in view: its phases as one Steps strip above the calls
  const phases = councilPhases(allItems.filter((i) => i.call).map((i) => ({ tool: i.call!.title, status: i.call!.status, ts: i.call!.ts })));
  const councilNode = phases.length ? (
    <Box height={1} overflow="hidden"><Text wrap="truncate-end"><Text bold color={THEME.chat}>COUNCIL </Text>{stepsLine(phases, frame)}</Text></Box>
  ) : null;

  const groups = useMemo(() => timeGroups(items), [items]);
  useMemo(() => {
    // step → phase, and what ran at it: the planner call at step N names the tool step N runs ("Next → …")
    const m = new Map<number, PlannerStepInfo>();
    for (const x of allItems) {
      if (!x.call || !/planner_maker$/.test(x.call.title)) continue;
      const p = parsePlanner(visibleOf(x.call.fullAnsi ?? x.call.full ?? x.call.output ?? ""));
      if (p) m.set(p.step, { phase: p.phase, action: p.next?.desc, tool: p.next?.tool });
    }
    plannerPhases = m;
    setPlannerSteps(m);
    // nextThought: the run around the open call — consecutive nextThought calls in its question
    setThoughtChain((output) => {
      const all = allItems.filter((x) => x.call && /nextThought$/.test(x.call.title));
      const at = all.findIndex((x) => visibleOf(x.call!.fullAnsi ?? x.call!.full ?? x.call!.output ?? "") === output);
      if (at < 0) return [];
      // the run: walk back to thought 1 and forward while the numbers keep rising
      const num = (x: Item) => {
        try { return Number(JSON.parse(x.call!.inputFull ?? x.call!.input ?? "{}").thoughtNumber) || 0; } catch { return Number(/"thoughtNumber"\s*:\s*(\d+)/.exec(x.call!.inputFull ?? "")?.[1] ?? 0); }
      };
      let a = at;
      while (a > 0 && num(all[a - 1]) > 0 && num(all[a - 1]) < num(all[a])) a--;
      let b = at;
      while (b + 1 < all.length && num(all[b + 1]) > num(all[b])) b++;
      return all.slice(a, b + 1).map((x, k) => {
        // the args are model-written JSON: coerce the types, strip every control char before drawing
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(x.call!.inputFull ?? x.call!.input ?? "{}"); } catch { /* keep defaults */ }
        const thought = typeof args.thought === "string" ? args.thought : visibleOf(x.call!.output ?? "");
        const gist = stripControls(thought).replace(/\s+/g, " ").trim();
        const model = stripControls(typeof args.model === "string" ? args.model : "claude").slice(0, 24);
        const total = typeof args.totalThoughts === "number" && Number.isFinite(args.totalThoughts) ? args.totalThoughts : undefined;
        return { n: num(x) || k + 1, total, model, gist, current: a + k === at };
      });
    });
  }, [allItems]);
  const qgroups = useMemo(() => questionGroups(items, s.prompts, s.labels), [items, s.prompts, s.labels]);
  const openGroup = qgroups.find((g) => idx >= g.start && idx <= g.end);
  const groupHeader = (g: QuestionGroup, open: boolean, w: number) => {
    const n = items.slice(g.start, g.end + 1).filter((it) => it.call).length;
    const at = new Date((items[g.start].call ?? items[g.start].loose)!.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return (
      <Box key={`g${g.key}${g.start}`} height={1} overflow="hidden">
        <Box flexGrow={1} flexShrink={1} overflow="hidden">
          <Text wrap="truncate-end">
            <Text color={open ? THEME.chat : THEME.muted}>{open ? "▾ " : "▸ "}</Text>
            <Text color={open ? THEME.chat : THEME.text} bold={open}>{g.label}</Text>
          </Text>
        </Box>
        <Box flexShrink={0}>
          <Text>
            <Text backgroundColor={THEME.tagBg} color={n ? THEME.calls : THEME.muted}>{` ${n} `}</Text>
            <Text color={THEME.muted}>{` ${at.replace(/\s?(AM|PM)$/i, "").padStart(5)}`}</Text>
          </Text>
        </Box>
      </Box>
    );
  };
  const divider = (i: number, w: number) => {
    const label = groups.get(i);
    if (!label) return null;
    const side = Math.max(2, Math.floor((w - label.length - 2) / 2));
    return <Text key={`d${i}`} dimColor wrap="truncate-end">{`${"─".repeat(side)} ${label} ${"─".repeat(side)}`}</Text>;
  };

  const rowNode = (it: Item, i: number, selected = false, inOpen = false) => (
    <Row key={(it.call ?? it.loose)!.key + i} it={it} selected={selected} reviewing={!!it.call && s.reviewingKey === it.call.key} frame={frame} now={nowMs} inOpen={inOpen} width={wide ? listW - 4 : width} />
  );

  let body: ReactNode;
  if (help) {
    body = <HelpView view={view} width={width} />;
  } else if (view === "memory") {
    body = <MemoryView cwd={s.cwd} files={s.memoryList} sel={Math.min(memSel, Math.max(0, s.memoryList.length - 1))} off={memOff} width={size.cols - 1} rows={bodyRows} dokoroSearch={s.dokoroSearch} focus={memFocus} focusColor={focusColor(THEME.memory)} onMax={(n) => { memMax.current = n; }} onRows={onRows} onLinks={(zones, left) => { linkZones.current = { zones, left }; }} raw={memRaw} folded={memFolded} onHeads={(h) => { memHeads.current = h; }} />;
  } else if (view === "prompts") {
    body = <PromptsView list={ranked} total={s.techniques?.length} from={s.techniquesFrom} sel={Math.min(promptSel, Math.max(0, ranked.length - 1))} query={input} width={size.cols - 1} rows={bodyRows} categories={categories} catIdx={catIdx} coreOnly={coreOnly} recommended={s.recommended} frame={frame} onRows={onRows} />;
  } else if (view === "calls" && queries.calls && !items.length) {
    body = (
      <Box flexDirection="column" paddingTop={1}>
        <Text color={THEME.note}>{`no calls match “${queries.calls}”`}</Text>
        <Text color={THEME.muted}>^F to edit the search · Esc clears it</Text>
      </Box>
    );
  } else if (view === "home" || (!items.length && view === "calls")) {
    body = <StartPage s={s} width={width} calls={calls} height={bodyRows - 1} />; // the frame stops one row short of the terminal
  } else if (wide && (view !== "chat" || threeCol)) {
    // split: calls · open card (· chat at ≥140 cols), side by side
    const listRows = bodyRows - 2;
    const first = Math.max(0, Math.min(idx - Math.floor(listRows / 2), items.length - listRows));
    body = (
      <Box flexDirection="row" gap={1} flexGrow={1}>
        <Box flexDirection="column" width={listW} flexShrink={0} overflow="hidden" borderStyle={focusPane === "list" ? "bold" : "round"} borderColor={focusPane === "list" ? focusColor(THEME.chat) : "#30363d"} paddingX={1}>
          <Text wrap="truncate-end">
            {focusPane === "list" ? <Text backgroundColor={THEME.chat} color="#0d1117" bold>{` CALLS ${calls.length} `}</Text> : <Text bold color={THEME.calls}>CALLS {calls.length}</Text>}
            {sel !== null && idx < items.length - 1 ? <Text color={THEME.note}>{`  ${items.slice(idx + 1).filter((i) => i.call).length} newer · G follows`}</Text> : null}
          </Text>
          {councilNode}
          {(() => {
            // one row per question; the open question lists its calls
            const rowsOut: ReactNode[] = [];
            const targets: number[] = []; // the item index each row opens (a header opens its question's last call)
            let at = 0;
            const pins = items.map((x, k) => [x, k] as const).filter(([x]) => x.call && starred.has(x.call.key));
            if (pins.length) {
              rowsOut.push(<Box key="pinhead" height={1}><Text color={THEME.note} bold>{`★ PINNED  ${pins.length}`}</Text></Box>);
              targets.push(pins[0][1]);
              for (const [x, k] of pins) {
                rowsOut.push(rowNode(x, k, false, true));
                targets.push(k);
              }
            }
            for (const g of qgroups) {
              const open = g === openGroup;
              rowsOut.push(groupHeader(g, open, listW - 4));
              targets.push(g.end);
              if (open) {
                // a plan in this question: its step strip heads the timeline
                let lastPlanner = -1;
                for (let k = g.start; k <= g.end; k++) if (items[k].call && /planner_maker$/.test(items[k].call!.title)) lastPlanner = k;
                const st = lastPlanner >= 0 ? /Step\s+(\d+)\s*\/\s*(\d+)/.exec(items[lastPlanner].call!.output ?? items[lastPlanner].call!.full ?? "") : null;
                if (st) {
                  const cur = Number(st[1]);
                  const tot = Number(st[2]);
                  const circ = (n: number) => String.fromCodePoint(0x2460 + n - 1);
                  rowsOut.push(
                    <Box key={`pl${g.start}`} height={1} overflow="hidden" backgroundColor={OPEN_BG}>
                      <Text wrap="truncate-end">
                        <Text color={THEME.muted}>{"  PLANNER "}</Text>
                        {Array.from({ length: tot }, (_, j) => (
                          <Text key={j} color={j + 1 < cur ? THEME.ok : j + 1 === cur ? THEME.note : THEME.muted} bold={j + 1 === cur}>{`${j ? (j + 1 <= cur ? "━" : "─") : ""}${circ(j + 1)}`}</Text>
                        ))}
                      </Text>
                    </Box>,
                  );
                  targets.push(lastPlanner);
                }
                for (let k = g.start; k <= g.end; k++) {
                  if (k === idx) at = rowsOut.length;
                  rowsOut.push(rowNode(items[k], k, k === idx, true));
                  targets.push(k);
                }
              }
            }
            // a legend under the list when there is room: what the dots mean
            const legend = rowsOut.length + 2 <= listRows - 1 - (councilNode ? 1 : 0);
            const fit = listRows - 1 - (councilNode ? 1 : 0) - (legend ? 2 : 0);
            const from = Math.max(0, Math.min(at - Math.floor(fit / 2), rowsOut.length - fit));
            // header rows + border + title (+ council strip) sit above the first row
            listClicks.current = { top: 2 + (councilNode ? 1 : 0), targets: targets.slice(from, from + fit) };
            const shownRows = rowsOut.slice(from, from + fit);
            if (!legend) return shownRows;
            return [
              ...shownRows,
              <Box key="spacer" flexGrow={1} />,
              <Box key="legend" height={1} overflow="hidden">
                <Text wrap="truncate-end"><Text color={THEME.ok}>●</Text><Text color={THEME.muted}> ok  </Text><Text color={THEME.note}>◉</Text><Text color={THEME.muted}> open  </Text><Text color="#ff7b72">✗</Text><Text color={THEME.muted}> error  </Text><Text color={THEME.note}>◆</Text><Text color={THEME.muted}> brain  </Text><Text color={THEME.note}>●2</Text><Text color={THEME.muted}> notes</Text></Text>
              </Box>,
            ];
          })()}
        </Box>
        {(() => {
          // compare: the marked call and the open one as two sibling columns (nesting shifts the inner box)
          const other = compareKey && compareKey !== current?.call?.key ? allItems.find((x) => x.call?.key === compareKey) : undefined;
          if (!current) return <Box width={cardW} flexShrink={0} />;
          if (!other) return <Box flexDirection="column" width={cardW} flexShrink={0} overflow="hidden">{cardNode(current, cardW, bodyRows)}</Box>;
          const half = Math.floor((cardW - 1) / 2);
          return [
            <Box key="cmp-a" flexDirection="column" width={half} flexShrink={0} overflow="hidden">{cardNode(other, half, bodyRows)}</Box>,
            <Box key="cmp-b" flexDirection="column" width={cardW - half - 1} flexShrink={0} overflow="hidden">{cardNode(current, cardW - half - 1, bodyRows)}</Box>,
          ];
        })()}
        {threeCol ? (
          <Box flexDirection="column" width={chatW} flexShrink={0} overflow="hidden" borderStyle={focusPane === "chat" ? "bold" : "round"} borderColor={focusPane === "chat" ? focusColor(THEME.chat) : "#30363d"} paddingX={1}>
            <Text wrap="truncate-end">
              {focusPane === "chat" ? <Text backgroundColor={THEME.chat} color="#0d1117" bold>{" CHAT · SECOND BRAIN "}</Text> : <Text bold color={THEME.chat}>CHAT · SECOND BRAIN</Text>}
              <Text>{"  "}</Text>
              {chatSolo ? <Text backgroundColor={THEME.chat} color="#0d1117" bold>{" SOLO "}</Text> : <Text backgroundColor={THEME.tagBg} color={THEME.muted}>{" ALL "}</Text>}
              <Text color={THEME.muted}>{" ^N"}</Text>
            </Text>
            {chatNode(chatW - 4, bodyRows - 3)}
          </Box>
        ) : null}
      </Box>
    );
  } else if (view === "chat") {
    body = chatNode(width, bodyRows);
  } else if (current) {
    // narrow: a few collapsed rows above the open call, then its card fills the rest
    const gStart = openGroup?.start ?? 0;
    const gEnd = openGroup?.end ?? items.length - 1;
    const above = Math.min(idx - gStart, Math.max(1, Math.floor(bodyRows / 4)));
    const below = Math.min(gEnd - idx, 2);
    body = (
      <Box flexDirection="column">
        {councilNode}
        {openGroup ? groupHeader(openGroup, true, width) : null}
        {items.slice(idx - above, idx).map((it, i) => rowNode(it, i))}
        {rowNode(current, -1, true)}
        {cardNode(current, width, bodyRows - above - below - 1 - (councilNode ? 1 : 0) - (openGroup ? 1 : 0))}
        {items.slice(idx + 1, idx + 1 + below).map((it, i) => rowNode(it, 100 + i))}
      </Box>
    );
  }

  return (
    // never taller than the terminal: an overflowing frame makes Ink reprint it below the old one
    <Box flexDirection="column" height={rows} overflow="hidden">
      <Box ref={headerRef} flexDirection="column" flexShrink={0}>
        <Header s={s} calls={calls} width={size.cols - 1} status={lastStatus} view={view} chatCount={chatCount} frame={frame} />
      </Box>
      <Box flexDirection="column" flexGrow={1} overflow="hidden">{body}</Box>
      {s.proposal ? (
        <Box borderStyle="round" borderColor="#e3b341" paddingX={1} flexDirection="column" flexShrink={0}>
          <Text wrap="truncate-end"><Text bold color="#e3b341">⚠ to Claude?</Text><Text dimColor>{editing ? "  Enter send · Esc cancel" : reviewing === s.proposal ? (reviewFits ? "  all of it is shown · ^S send · ^E edit · Esc drop" : "  pane too short to show it all · ^E read/edit · Esc drop") : proposalLines.length > 3 ? "  ^S read all · ^E edit · Esc drop" : "  ^S send · ^E edit · Esc drop"}</Text></Text>
          {proposalShown.map((l, i) => <Text key={i}>{l || " "}</Text>)}
        </Box>
      ) : null}
      {(searching || query) && (view === "calls" || view === "chat") ? (
        <Box flexShrink={0}>
          <Text bold color="#d2a8ff">{searching ? "search › " : "filter › "}</Text>
          <Text>{query}</Text>
          {searching ? <Text inverse> </Text> : null}
          <Text dimColor>{view === "chat" ? `  in the conversation · ${searching ? "Enter keep · Esc clear" : "^F edit · Esc clear"}` : `  ${items.filter((i) => i.call).length} of ${allItems.filter((i) => i.call).length} calls · ${searching ? "Enter keep · Esc clear" : "^F edit · Esc clear"}`}</Text>
        </Box>
      ) : null}
      {attached ? (
        <Box flexShrink={0} height={1} overflow="hidden">
          <Text wrap="truncate-end">
            <Text backgroundColor={THEME.chat} color="#0d1117" bold>{" 📎 SELECTION "}</Text>
            <Text color={THEME.muted}>{` ${attached.length.toLocaleString()} chars `}</Text>
            <Text color={THEME.text}>{`“${attached.replace(/\s+/g, " ").slice(0, 48)}${attached.length > 48 ? "…" : ""}”`}</Text>
            <Text color={THEME.muted}>{"  copied · type a question + Enter → brain · "}</Text><Text color={THEME.chat}>{"@claude …"}</Text><Text color={THEME.muted}>{" → Claude · Esc drops"}</Text>
          </Text>
        </Box>
      ) : null}
      <Box flexShrink={0} flexDirection="column">
        {inputLines.map((l, i) => (
          <Text key={i} wrap="truncate-end">
            {i === 0 ? <Text bold color={editing ? "#e3b341" : view === "home" ? THEME.watcher : THEME[view]}>{promptLabel}</Text> : <Text>{" ".repeat(promptLabel.length)}</Text>}
            <Text>{l}</Text>
            {i === inputLines.length - 1 ? <Text inverse> </Text> : null}
          </Text>
        ))}
      </Box>
      {dragTo ? <Text wrap="truncate-end"><Text backgroundColor={THEME.chat} color="#0d1117" bold>{" ✎ SELECTING "}</Text><Text color={THEME.text}>{"  release to copy · the text then rides along with your next question"}</Text></Text> : selectMode ? <Text wrap="truncate-end"><Text backgroundColor={THEME.memory} color="#0d1117" bold>{" ✎ SELECT "}</Text><Text color={THEME.text}>{"  drag to select · ⌘C copy · ⌘-click links · "}</Text><Text color={THEME.memory} bold>{"Esc / ^X"}</Text><Text color={THEME.muted}>{` back to scroll & click · auto in ${Math.max(0, Math.ceil((SELECT_MS - (nowMs - selectAt.current)) / 1000))}s`}</Text></Text> : toast && nowMs - toast.at < 2500 ? <Text color={THEME.ok} bold wrap="truncate-end">{toast.text}<Text color={THEME.muted} bold={false}>{toast.text.startsWith("✓ copied") ? "  · paste it anywhere" : ""}</Text></Text> : <Text dimColor wrap="truncate-end">
        <Text color="#79c0ff">{view}</Text>
        {view === "calls" ? (sel === null
          ? <Text color={THEME.ok}> ● following</Text>
          : <Text color={THEME.note}> ○ pinned · ↓ to end follows</Text>) : null}
        {view === "memory"
          ? ` · click a file · ↑↓ ${memFocus === "files" ? "pick file" : "scroll"} · ^Y copy · ^O next heading · ^R ${memRaw ? "reader" : "raw"} · drag to select`
          : view === "prompts"
          ? " · Enter apply → Claude · Esc clear filters · type a task · ^R codex picks · ←→ category · ^O core · ^Y copy"
          : view === "home"
          ? " · ↑↓/Tab open calls · 1-3 ask · ^C quit"
          : view === "chat"
          ? size.cols < 80
            ? ` · Tab · ↑↓${followups.length ? " · 1-3" : ""} · Esc home`
            : ` · ${chatSolo ? "SOLO · " : ""}^N ${chatSolo ? "show notes" : "solo"} · ↑↓ scroll${followups.length ? " · 1-3 follow-up" : ""} · @claude <text> → Claude · Esc home`
          : size.cols < 80
            ? " · Tab · ↑↓ · ^F · Esc home"
            : wide
              ? ` · click a call · ←→ focus ${focusPane} · ↑↓ move · drag select · ^Y copy · ^P pin · ^K export · ^O compare · ? keys`
              : " · Tab chat · ↑↓ select · ^F search · ^B models · ^T density · ? keys · Esc home"}
      </Text>}
    </Box>
  );
}

// debugging aid: `touch ~/.tachi/keylog.on` logs every key event to ~/.tachi/keylog.jsonl
const KEYLOG = process.env.TACHI_WATCH_KEYLOG || (fs.existsSync(`${homedir()}/.tachi/keylog.on`) ? `${homedir()}/.tachi/keylog.jsonl` : "");

/** The last frame Ink drew, as plain text rows (row 0 = terminal row 1) — what a mouse drag selects from. */
const screens = new WeakMap<object, string[]>();
const ESC_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;
function captureFrame(out: object, chunk: string): void {
  if ((chunk.match(/\n/g) ?? []).length < 3) return; // not a frame
  screens.set(out, chunk.replace(ESC_RE, "").split("\n"));
}

/**
 * The text a drag from `a` to `b` covers (1-based terminal coordinates), inside the pane the drag
 * started in — bounded by that row's box borders, so a split never mixes panes. Reading order.
 */
export function selectText(rows: string[], a: { x: number; y: number }, b: { x: number; y: number }): string {
  const [p, q] = a.y < b.y || (a.y === b.y && a.x <= b.x) ? [a, b] : [b, a];
  const chars = (l: string) => Array.from(l ?? "");
  const row0 = chars(rows[a.y - 1]);
  let left = -1;
  let right = row0.length;
  for (let i = Math.min(a.x - 1, row0.length - 1); i >= 0; i--) if (/[│┃]/.test(row0[i])) { left = i; break; }
  for (let i = a.x - 1; i < row0.length; i++) if (/[│┃]/.test(row0[i])) { right = i; break; }
  if (left < 0 || right >= row0.length) return ""; // outside a bordered pane (header, tabs, input): no selection
  const out: string[] = [];
  for (let y = p.y; y <= q.y; y++) {
    const r = chars(rows[y - 1]);
    const from = y === p.y ? Math.max(left + 1, p.x - 1) : left + 1;
    const to = y === q.y ? Math.min(right, q.x) : right;
    out.push(r.slice(from, to).join("").replace(/[▐█]\s*$/, "").replace(/^ (?=\S)/, y === p.y ? " " : "").trimEnd());
  }
  return out.join("\n").replace(/^\s+|\s+$/g, "");
}

const MOUSE_ON = "\x1b[?1002h\x1b[?1006h"; // button, drag-motion and wheel reports, SGR encoding
const MOUSE_OFF = "\x1b[?1002l\x1b[?1000l\x1b[?1006l";

export async function renderWatchUi(controller: WatchController, options: Parameters<typeof render>[1] = {}): Promise<void> {
  // the wheel scrolls the pane; Shift-drag still selects text in every terminal that supports this
  const mouse = controller.getState().mouse !== false && !(typeof options === "object" && "stdout" in options && options.stdout);
  if (mouse) process.stdout.write(MOUSE_ON);
  // keep a plain copy of each frame so a mouse drag can select text from it
  const target = (typeof options === "object" && "stdout" in options && options.stdout) || process.stdout;
  const write = target.write.bind(target) as (c: unknown, ...rest: unknown[]) => boolean;
  // a terminal without 24-bit colour gets the same frame in the 256-colour palette
  const paint = target !== process.stdout || supportsTruecolor(process.env) ? (c: string) => c : to256;
  (target as { write: unknown }).write = (c: unknown, ...rest: unknown[]) => {
    if (typeof c === "string") captureFrame(target, c);
    return write(typeof c === "string" ? paint(c) : c, ...rest);
  };
  const off = () => mouse && process.stdout.write(MOUSE_OFF);
  process.once("exit", off);
  const app = render(<App controller={controller} />, { exitOnCtrlC: false, ...(typeof options === "object" ? options : {}) });
  await app.waitUntilExit();
  off();
}
