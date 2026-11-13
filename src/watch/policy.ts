/**
 * tachi-watch — when to review, what to ask, how to read the answer. Pure.
 *
 * A review yields NOTES (shown in the watcher pane, each citing its source —
 * "CLAUDE.md:42 says X, Claude did Y") and at most one FLAG. A FLAG only
 * becomes a proposal: the human sends, edits or cancels it before anything
 * reaches Claude — the steer-with-approval contract of pi-watcher's steer_main.
 */
import type { WatchEvent } from "./events.js";
import type { Snippet } from "./memory.js";

export interface ReviewPolicy {
  /** Review after this many Claude tool calls since the last review. */
  everyToolCalls: number;
  /** Never review more often than this (ms). */
  minIntervalMs: number;
  /** Same tool+input this many times in the recent window → review (looping). */
  repeatThreshold: number;
}

export const DEFAULT_POLICY: ReviewPolicy = { everyToolCalls: 8, minIntervalMs: 45_000, repeatThreshold: 3 };

export type ReviewReason = "error" | "fallback" | "repeat" | "cadence" | "manual" | "tachibot";

/**
 * Decide whether the events since the last review warrant a review now.
 * `recent` is the rolling window (for repeat detection), `fresh` the events
 * since the last review.
 */
export function shouldReview(
  fresh: WatchEvent[],
  recent: WatchEvent[],
  msSinceLastReview: number,
  policy: ReviewPolicy = DEFAULT_POLICY,
): ReviewReason | undefined {
  if (fresh.length === 0 || msSinceLastReview < policy.minIntervalMs) return undefined;
  if (fresh.some((e) => e.kind === "tool-error" || e.kind === "model-error")) return "error";
  if (fresh.some((e) => e.kind === "fallback")) return "fallback";

  const counts = new Map<string, number>();
  for (const e of recent) if (e.kind === "tool") counts.set(e.text, (counts.get(e.text) ?? 0) + 1);
  const freshTools = new Set(fresh.filter((e) => e.kind === "tool").map((e) => e.text));
  for (const t of freshTools) if ((counts.get(t) ?? 0) >= policy.repeatThreshold) return "repeat";

  if (fresh.filter((e) => e.kind === "tool").length >= policy.everyToolCalls) return "cadence";
  return undefined;
}

export const WATCHER_SYSTEM_PROMPT = `You are tachi-watch, a second pair of eyes beside a Claude Code session.
You get: a log of what the user asked, what Claude (the coding agent) did, and what tachibot (its multi-model tools) returned; plus excerpts from the project's written memory (CLAUDE.md, memory notes, dokoro), each labelled with its source.

Your main job: catch Claude contradicting what was decided or said before. Compare the recent actions against the memory excerpts and the user's own words in the log.
Also catch: repeating a failing action, errors silently worked around, actions the user did not ask for, model fallbacks that weaken an answer Claude relies on.

Do NOT comment on normal progress, style, or anything already handled. Silence is the default.

Reply with lines in exactly these forms (no other text):
NOTE: now | <ALWAYS first: one sentence on what Claude is doing right now and whether it matches what the user asked>
NOTE: <source> | <what you noticed, e.g. "CLAUDE.md:42 says tools name a provider, never a model version — Claude just wrote 'gpt-6-astra' into a tool description">
FLAG: <one short message addressed to Claude: what to check or fix. Max 3 sentences.>

Rules: <source> is a memory label like CLAUDE.md:42, "user", "log", or "tachibot". Always the "now" note; further NOTE lines only for real findings; at most one FLAG, only when Claude should be interrupted.`;

export const CALL_REVIEW_SYSTEM_PROMPT = `You are tachi-watch, a second brain beside a Claude Code session. Claude just called a tachibot tool (a multi-model AI tool); you see the call's full input and output, what the user recently asked, and excerpts of the project's written memory (CLAUDE.md, memory notes, dokoro), each labelled with its source.

Check the tachibot result against memory and the user's words:
- does it contradict a decision, rule or fact recorded in memory? cite the label
- does it rely on stale facts (old model names, removed tools, outdated versions)?
- did a model fail or fall back so the answer is weaker than it looks?
- is something in it worth the user knowing that Claude may gloss over?

Be brief and concrete. Silence is fine.
Reply with lines in exactly these forms (no other text):
NOTE: <source> | <observation — e.g. "memory/tool-description-policy.md:1 says never pin model versions; the answer recommends hard-coding gpt-6-astra">
FLAG: <one short message for Claude, only if Claude should change course. Max 3 sentences.>
OK`;

export interface CallForReview {
  title: string;
  input?: string;
  output?: string;
  status: string;
  models?: string[];
}

export function buildCallReviewPrompt(call: CallForReview, userPrompts: string[], snippets: Snippet[], dokoro = ""): string {
  const parts: string[] = [];
  if (userPrompts.length) parts.push(`User recently asked:\n${userPrompts.map((p) => `- ${p}`).join("\n")}`);
  if (snippets.length) parts.push(`Project memory excerpts:\n${snippets.map((s) => `[${s.source}]\n${s.text}`).join("\n\n")}`);
  if (dokoro.trim()) parts.push(`dokoro recall:\n${dokoro.trim().slice(0, 3000)}`);
  parts.push(`tachibot call: ${call.title} (${call.status})${call.models?.length ? `\nmodels: ${call.models.join(", ")}` : ""}`);
  // The reviewer gets the call whole (events cap outputs at 20k chars) — a reviewer
  // that only sees the first part of an answer can't check the rest of it.
  parts.push(`INPUT:\n${call.input ?? ""}`);
  parts.push(`OUTPUT:\n${call.output ?? ""}`);
  parts.push("NOTE / FLAG / OK?");
  return parts.join("\n\n");
}

export function formatLog(events: WatchEvent[]): string {
  return events
    .map((e) => `${new Date(e.ts).toISOString().slice(11, 19)} [${e.source}/${e.kind}] ${e.text}`)
    .join("\n");
}

export function buildReviewPrompt(reason: ReviewReason, recent: WatchEvent[], snippets: Snippet[], dokoro = ""): string {
  const mem = snippets.map((s) => `[${s.source}]\n${s.text}`).join("\n\n");
  const parts = [`Review trigger: ${reason}.`];
  if (mem) parts.push(`Project memory excerpts:\n${mem}`);
  if (dokoro.trim()) parts.push(`dokoro recall:\n${dokoro.trim().slice(0, 3000)}`);
  parts.push(`Recent activity (oldest first; "tool" lines include their input, results follow):\n${formatLog(recent)}`);
  parts.push("NOTE / FLAG / OK?");
  return parts.join("\n\n");
}

export interface ReviewResult {
  notes: Array<{ source: string; text: string }>;
  flag?: string;
}

const strip = (raw: string) => raw.replace(/^[\s*>#`-]+/, "").replace(/\*\*/g, "").trim();

/** Lenient parse: models add chatter and markdown, so scan for NOTE / FLAG lines. */
export function parseReview(answer: string): ReviewResult {
  const notes: ReviewResult["notes"] = [];
  let flag: string | undefined;
  const lines = answer.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = strip(lines[i]);
    const note = /^NOTE\s*[:\-–]\s*(.+)$/i.exec(line);
    if (note) {
      const [src, ...rest] = note[1].split("|");
      const text = rest.join("|").trim();
      notes.push(text ? { source: src.trim(), text } : { source: "watch", text: src.trim() });
      continue;
    }
    const f = /^FLAG\s*[:\-–]\s*(.+)$/i.exec(line);
    if (f && flag === undefined) {
      // the message may wrap onto following non-directive lines
      const more: string[] = [];
      while (i + 1 < lines.length && strip(lines[i + 1]) && !/^(NOTE|FLAG|OK)\b/i.test(strip(lines[i + 1]))) more.push(strip(lines[++i]));
      flag = [f[1].trim(), ...more].join(" ").replace(/\s+/g, " ");
    }
  }
  return flag === undefined ? { notes } : { notes, flag };
}
