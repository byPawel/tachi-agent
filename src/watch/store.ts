/**
 * tachi-watch — events → cards (pure). A card is one thing on screen: a user
 * prompt, a Claude tool call with its input/output, a tachibot call with the
 * model calls it made nested underneath, or something the watcher said.
 *
 * Two sources describe the same tachibot call: Claude's transcript (the
 * mcp__tachibot-mcp__* tool_use/tool_result) and tachibot's own trace stream
 * (tool span + nested model spans). The trace's top-level tool span is ALIASED
 * onto the transcript card, so its model spans nest under one card instead of
 * a duplicate. Arrays/maps are replaced, never mutated (React state).
 */
import type { WatchEvent } from "./events.js";

export type CardType = "prompt" | "say" | "tool" | "span" | "thought" | "note" | "answer" | "status";
export type CardStatus = "running" | "ok" | "error" | "fallback" | "info";

export interface Card {
  /** tokens this call (a model span) spent, summed over its usage reports */
  tokensIn?: number;
  tokensOut?: number;
  tokensReasoning?: number;
  key: string;
  type: CardType;
  title: string;
  status: CardStatus;
  ts: number;
  depth: number;
  source: "claude" | "tachibot" | "watch";
  input?: string;
  output?: string;
  /** Multi-line output for the card body / expanded view. */
  full?: string;
  /** All call arguments, `key: value` per line. */
  inputFull?: string;
  /** Output with tachibot's terminal styling, when it had any. */
  fullAnsi?: string;
  /** note: the call it is about (card key) */
  about?: string;
  ms?: number;
  /** note: where the watcher found it (CLAUDE.md:42, user…); fallback: model that answered */
  cite?: string;
  /** Claude's call went to tachibot. */
  via?: "tachibot";
  tool?: string;
  /** Claude moved the call to the background; the result comes back under this task id. */
  taskId?: string;
  /** answer: next questions the brain suggests (OpenUI's FollowUpBlock) */
  followups?: string[];
  /** answer: the memory it drew on (sources), shown as "behind the scenes" */
  context?: string[];
}

export interface CardState {
  cards: Card[];
  /** trace span id → transcript card key */
  alias: Record<string, string>;
}

export const EMPTY: CardState = { cards: [], alias: {} };

let seq = 0;
const nextKey = (p: string) => `${p}${++seq}`;

/** A trace tool span belongs to the transcript card of the same tachibot tool started within this window. */
const ALIAS_WINDOW_MS = 15_000;

function cap(cards: Card[], max: number): Card[] {
  return cards.length > max ? cards.slice(cards.length - max) : cards;
}

function patchCard(cards: Card[], key: string, patch: Partial<Card>): Card[] | undefined {
  const i = cards.findIndex((c) => c.key === key);
  if (i < 0) return undefined;
  const next = cards.slice();
  next[i] = { ...cards[i], ...patch };
  return next;
}

/** Insert after the parent's last descendant so nested cards stay under their parent. */
function insertChild(cards: Card[], parentKey: string | undefined, card: Card): Card[] {
  const pi = parentKey ? cards.findIndex((c) => c.key === parentKey) : -1;
  if (pi < 0) return [...cards, card];
  let end = pi + 1;
  while (end < cards.length && cards[end].depth > cards[pi].depth) end++;
  return [...cards.slice(0, end), card, ...cards.slice(end)];
}

export function applyEvent(state: CardState, e: WatchEvent, max = 200): CardState {
  const { cards, alias } = state;
  const resolve = (id: string | undefined) => (id ? alias[id] ?? id : undefined);
  const depthOf = (parentId: string | undefined) => {
    const p = cards.find((c) => c.key === resolve(parentId));
    return p ? p.depth + 1 : 0;
  };
  const add = (card: Card, parentId?: string): CardState => ({ cards: cap(insertChild(cards, resolve(parentId), card), max), alias });
  const base = { ts: e.ts, source: e.source, depth: 0 } as const;

  switch (e.kind) {
    case "prompt":
      return add({ ...base, key: nextKey("p"), type: "prompt", title: "you", status: "info", output: e.text });
    case "text":
      return add({ ...base, key: nextKey("c"), type: "say", title: "claude", status: "info", output: e.text });
    case "tool":
      return add({
        ...base, key: e.id ?? nextKey("t"), type: "tool", status: "running", input: e.input, inputFull: e.inputFull, via: e.via, tool: e.tool,
        title: e.via === "tachibot" ? `tachibot · ${e.tool}` : e.text.split(": ")[0],
      });
    case "tool-bg": {
      const card = e.id ? cards.find((c) => c.key === e.id) : undefined;
      if (!card) return state;
      return { cards: patchCard(cards, card.key, { status: "running", taskId: e.taskId }) ?? cards, alias };
    }
    case "tool-ok":
    case "tool-error": {
      // tachibot returns provider failures as text ("[Grok timeout: …]", "[Jev error: …]") — those are errors, not ok
      const failedAsText = /^\s*(?:\x1b\[[0-9;]*m|\s|[^\n]*jev_decide|[^\n]*_[a-z]+ \x1b)*\[[\w .-]{0,30}\b(?:timeout|error)\b[^\]]*\]\s*$/i.test((e.outputFull ?? e.output ?? "").replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n").filter((l) => l.trim()).slice(-1)[0] ?? "")
        && (e.outputFull ?? e.output ?? "").replace(/\x1b\[[0-9;]*m/g, "").trim().length < 400;
      const status: CardStatus = e.kind === "tool-ok" && !failedAsText ? "ok" : "error";
      const card = e.id ? cards.find((c) => c.key === e.id) : e.taskId ? cards.find((c) => c.taskId === e.taskId) : undefined;
      if (!card && e.taskId) return state; // a background task we never saw start (or not a tool)
      if (card) {
        // a fallback seen on the trace stream outranks a plain "ok"
        const keep = card.status === "fallback" && status === "ok";
        return { cards: patchCard(cards, card.key, { status: keep ? "fallback" : status, output: e.output, full: e.outputFull, fullAnsi: e.outputAnsi, ms: e.ts - card.ts }) ?? cards, alias };
      }
      return state; // result of a call we don't list (plain Claude tool, or before the backfill)
    }
    case "span": {
      if (e.spanKind === "tool" && !e.parentId && e.id) {
        const host = [...cards].reverse().find(
          (c) => c.via === "tachibot" && c.tool === e.tool && Math.abs(e.ts - c.ts) < ALIAS_WINDOW_MS && !Object.values(alias).includes(c.key),
        );
        if (host) return { cards, alias: { ...alias, [e.id]: host.key } };
      }
      return add({
        ...base, key: e.id ?? nextKey("s"), type: "span", title: e.spanKind === "model" ? (e.tool ?? e.text) : e.text,
        status: "running", depth: depthOf(e.parentId), input: e.input, tool: e.tool,
      }, e.parentId);
    }
    case "usage": {
      const key = resolve(e.id);
      const target = key ? cards.find((c) => c.key === key) : undefined;
      if (!target) return state;
      const add2 = (a?: number, b?: number) => (a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0));
      return { cards: patchCard(cards, target.key, { tokensIn: add2(target.tokensIn, e.tokensIn), tokensOut: add2(target.tokensOut, e.tokensOut), tokensReasoning: add2(target.tokensReasoning, e.tokensReasoning) }) ?? cards, alias };
    }
    case "model":
    case "model-error":
    case "fallback": {
      const status: CardStatus = e.kind === "model" ? "ok" : e.kind === "model-error" ? "error" : "fallback";
      const key = resolve(e.id);
      const target = key ? cards.find((c) => c.key === key) : undefined;
      const patch: Partial<Card> = { status, ms: e.ms };
      if (e.kind === "fallback") patch.cite = /answered by (\S+)/.exec(e.text)?.[1];
      if (target?.via === "tachibot") {
        // aliased tool span: the transcript owns the output; only surface trouble
        if (status === "ok") return state;
        return { cards: patchCard(cards, target.key, { status, cite: patch.cite ?? target.cite }) ?? cards, alias };
      }
      if (e.output !== undefined) patch.output = e.output;
      if (e.outputFull !== undefined) patch.full = e.outputFull;
      if (target) return { cards: patchCard(cards, target.key, patch) ?? cards, alias };
      return add({ ...base, key: e.id ?? nextKey("s"), type: "span", title: e.tool ?? e.text, depth: depthOf(e.parentId), ...patch } as Card, e.parentId);
    }
    case "thought":
      return add({
        ...base, key: e.id ?? nextKey("th"), type: "thought", title: e.text.split(" ")[0], status: "info",
        depth: depthOf(e.parentId), input: e.input, output: e.output,
      }, e.parentId);
  }
}

/** Something the watcher itself says. */
export function watchCard(type: "note" | "answer" | "status", text: string, cite?: string, about?: string, now = Date.now()): Card {
  return { key: nextKey("w"), type, source: "watch", depth: 0, ts: now, status: "info", title: "watch", output: text, cite, about };
}

/** What the pane lists: tachibot calls, the model calls nested under them, and what the watcher said. */
export function isShown(c: Card): boolean {
  return c.via === "tachibot" || c.type === "span" || c.type === "thought" || c.type === "note" || c.type === "answer" || c.type === "status";
}

export interface Stats {
  tools: number;
  errors: number;
  tachibot: number;
  models: number;
  fallbacks: number;
  notes: number;
}

export function stats(cards: Card[]): Stats {
  const s: Stats = { tools: 0, errors: 0, tachibot: 0, models: 0, fallbacks: 0, notes: 0 };
  for (const c of cards) {
    if (c.type === "tool") c.via === "tachibot" ? s.tachibot++ : s.tools++;
    if (c.type === "span") s.models++;
    if (c.status === "error") s.errors++;
    if (c.status === "fallback") s.fallbacks++;
    if (c.type === "note") s.notes++;
  }
  return s;
}
