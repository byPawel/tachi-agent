/**
 * tachi-watch — terminal components named after OpenUI's (@openuidev/react-ui):
 * TabBar (Tabs), Tag, Callout, FollowUps (FollowUpBlock). OpenUI renders to the
 * DOM only; these are the same ideas drawn with Ink, so the pane speaks one
 * visual language — and an OpenUI Lang renderer could later map onto them.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Box, Text } from "ink";

/** One palette for the whole pane: each view has its own accent. */
export const THEME = {
  calls: "#7ee787",
  chat: "#79c0ff",
  prompts: "#d2a8ff",
  memory: "#e3b341",
  you: "#f0f6fc",
  watcher: "#79c0ff",
  note: "#e3b341",
  error: "#ff7b72",
  ok: "#7ee787",
  muted: "#8b949e",
  text: "#c9d1d9",
  selected: "#33415c",
  tagBg: "#1f2937",
} as const;

export type View = "home" | "calls" | "chat" | "prompts" | "memory";

/** Tabs: the active view is a solid block in its accent color, the other is dim. */
export function TabBar({ view, calls, chat, prompts, memory, busy }: { view: View; calls: number; chat: number; prompts?: number; memory?: number; busy?: boolean }) {
  const tab = (v: Exclude<View, "home">, label: string, n: number | string) =>
    view === v ? (
      <Text backgroundColor={THEME[v]} color="#0d1117" bold>{` ${label} ${n} `}</Text>
    ) : (
      <Text dimColor>{` ${label} ${n} `}</Text>
    );
  return (
    <Box height={1} overflow="hidden">
      <Text wrap="truncate-end">
        {view === "home" ? <Text backgroundColor={THEME.watcher} color="#0d1117" bold>{" HOME "}</Text> : <Text dimColor>{" HOME "}</Text>}
        <Text> </Text>
        {tab("calls", "CALLS", calls)}
        <Text> </Text>
        {tab("chat", "CHAT", chat)}
        <Text> </Text>
        {tab("prompts", "PROMPTS", prompts ?? "")}
        <Text> </Text>
        {tab("memory", "MEMORY", memory ?? "")}
        {busy && view !== "chat" ? <Text color={THEME.chat}> ⟳ answering</Text> : null}
        <Text dimColor>  Tab ⇄</Text>
      </Text>
    </Box>
  );
}

/** The 1-based column span of each tab as TabBar draws it — for mouse clicks. */
export function tabSpans(calls: number, chat: number, prompts?: number, memory?: number): Array<{ view: View; from: number; to: number }> {
  const parts: Array<[View, string]> = [["home", " HOME "], ["calls", ` CALLS ${calls} `], ["chat", ` CHAT ${chat} `], ["prompts", ` PROMPTS ${prompts ?? ""} `], ["memory", ` MEMORY ${memory ?? ""} `]];
  const out: Array<{ view: View; from: number; to: number }> = [];
  let x = 1;
  for (const [view, text] of parts) {
    out.push({ view, from: x, to: x + text.length - 1 });
    x += text.length + 1; // the space between tabs
  }
  return out;
}

/** A small pill — a model, a source, a status. */
export function Tag({ label, color = "#8b949e" }: { label: string; color?: string }) {
  return <Text backgroundColor={THEME.tagBg} color={color}>{` ${label} `}</Text>;
}

/** A colored left rule with a label line: a note, a warning, an error. */
export function Callout({ variant, title, lines }: { variant: "note" | "error" | "ok"; title: string; lines: string[] }) {
  const color = variant === "note" ? THEME.note : variant === "error" ? THEME.error : THEME.ok;
  return (
    <Box flexDirection="column" borderStyle="bold" borderLeft borderTop={false} borderRight={false} borderBottom={false} borderColor={color} paddingLeft={1}>
      <Text bold color={color}>{title}</Text>
      {lines.map((l, i) => <Text key={i}>{l || " "}</Text>)}
    </Box>
  );
}

/** Suggested next questions; with an empty input, 1–3 asks one. */
export function FollowUps({ items, width }: { items: string[]; width: number }) {
  if (!items.length) return null;
  return (
    <Box flexDirection="column">
      <Text dimColor>FOLLOW-UPS</Text>
      {items.slice(0, 3).map((q, i) => (
        <Text key={i} wrap="truncate-end">
          <Text color={THEME.chat} bold>{` ${i + 1} › `}</Text>
          <Text dimColor>{q.slice(0, Math.max(10, width - 6))}</Text>
        </Text>
      ))}
    </Box>
  );
}

/** "FOLLOWUPS: a | b | c" at the end of an answer → the answer without it, plus the list. */
export function splitFollowUps(answer: string): { text: string; followups: string[] } {
  const m = /\n?\s*\**FOLLOW-?UPS?\**\s*:\s*(.+)\s*$/i.exec(answer);
  if (!m) return { text: answer, followups: [] };
  const followups = m[1].split("|").map((q) => q.trim().replace(/^["'-\s]+|["'\s]+$/g, "")).filter(Boolean).slice(0, 3);
  return { text: answer.slice(0, m.index).trimEnd(), followups };
}

// --- motion + graphics ------------------------------------------------------

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** A frame counter that only ticks while something is in flight — an idle pane never redraws. */
export function useFrame(active: boolean, ms = 90): number {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setFrame((f) => (f + 1) % 1_000_000), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return frame;
}

export function Spinner({ frame, color = "#e3b341" }: { frame: number; color?: string }) {
  return <Text color={color}>{SPINNER[frame % SPINNER.length]}</Text>;
}

const BARS = "▁▂▃▄▅▆▇█";
/** Values as one row of bars, scaled to the largest. */
export function sparkline(values: number[]): string {
  if (!values.length) return "";
  const max = Math.max(...values, 1);
  return values.map((v) => BARS[Math.min(BARS.length - 1, Math.floor((v / max) * (BARS.length - 1)))]).join("");
}

/** A card's title row: icon, name, then pills. */
export function CardHeader({ icon, iconColor, title, tags }: { icon: ReactNode; iconColor?: string; title: string; tags: Array<{ label: string; color?: string }> }) {
  return (
    <Box height={1} overflow="hidden">
      <Text wrap="truncate-end">
        {typeof icon === "string" ? <Text color={iconColor}>{icon}</Text> : icon}
        <Text bold>{` ${title} `}</Text>
        {tags.map((t, i) => (
          <Text key={i}>
            <Text> </Text>
            <Tag label={t.label} color={t.color} />
          </Text>
        ))}
      </Text>
    </Box>
  );
}

// --- design pieces: shimmer, steps, gauge -----------------------------------

/** A light band sweeping across `text` (the running call's name). */
export function Shimmer({ text, frame, base = "#7ee787", hi = "#f0f6fc" }: { text: string; frame: number; base?: string; hi?: string }) {
  const span = text.length + 6;
  const at = (frame % span) - 3;
  return (
    <Text bold>
      {[...text].map((ch, i) => (
        <Text key={i} color={Math.abs(i - at) <= 1 ? hi : base}>{ch}</Text>
      ))}
    </Text>
  );
}

const rgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`;
};
/** A chip as an ANSI string (for lines that are wrapped and scrolled as text). */
export function chip(label: string, fg: string, bg: string): string {
  return `\x1b[48;2;${rgb(bg)}m\x1b[38;2;${rgb(fg)}m ${label} \x1b[0m`;
}

const CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";
export const STEP_STYLE: Record<string, { fg: string; bg: string; mark: string }> = {
  ok: { fg: "#7ee787", bg: "#12261a", mark: "✓" },
  running: { fg: "#e3b341", bg: "#2a1f0a", mark: "⠋" },
  fallback: { fg: "#e3b341", bg: "#2a1f0a", mark: "↳" },
  error: { fg: "#ff7b72", bg: "#3a1418", mark: "✗" },
  info: { fg: "#c9d1d9", bg: "#1f2937", mark: "·" },
};

/** OpenUI Steps: ① grok ✓ ─ ② kimi ✓ ─ ③ openai ↳ — one ANSI string to wrap. */
export function stepsLine(steps: Array<{ label: string; status: string }>, frame = 0, start = 0): string {
  return steps
    .map((s, j) => {
      const i = start + j;
      const st = STEP_STYLE[s.status] ?? STEP_STYLE.info;
      const mark = s.status === "running" ? SPINNER[frame % SPINNER.length] : st.mark;
      return chip(`${CIRCLED[i] ?? `${i + 1}.`} ${s.label} ${mark}`, st.fg, st.bg);
    })
    .join("\x1b[2m ─ \x1b[22m");
}

/** A timeout gauge: ████░░░░ 41/600s */
export function gauge(elapsedMs: number, totalMs: number, cells = 10): string {
  const f = Math.max(0, Math.min(1, elapsedMs / totalMs));
  const n = Math.round(f * cells);
  return `${"█".repeat(n)}${"░".repeat(cells - n)} ${Math.round(elapsedMs / 1000)}/${Math.round(totalMs / 1000)}s`;
}

/** "openrouter:moonshotai/kimi-k3" → "kimi-k3"; "grok:grok-4.7" → "grok-4.7". */
export function shortModel(title: string): string {
  const t = title.replace(/^tachibot · /, "");
  const after = t.includes(":") ? t.slice(t.indexOf(":") + 1) : t;
  return (after.split("/").pop() ?? after).slice(0, 18);
}

/** How long a tachibot tool may run before its timeout (tachibot's per-model limits). */
export function toolTimeoutMs(tool: string): number {
  return /kimi|deepseek|glm|qwen|stepfun|minimax|thinking|reason|jury|council|nextThought|planner/i.test(tool) ? 600_000 : 180_000;
}
