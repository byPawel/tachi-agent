/**
 * tachi-watch — markdown → styled terminal lines (pure). Model answers are
 * markdown; raw `**`/`##`/`|---|` is hard to read in a pane. Headings, bold,
 * inline code, bullets, quotes, code blocks and tables get terminal styling;
 * the text itself is never dropped. Returns lines already wrapped to `width`.
 */
import wrapAnsi from "wrap-ansi";

const SGR = (open: number, close: number) => (s: string) => `\x1b[${open}m${s}\x1b[${close}m`;
const bold = SGR(1, 22);
const dim = SGR(2, 22);
const italic = SGR(3, 23);
// the design palette (truecolor), same as THEME in components.tsx
const rgb = (r: number, g: number, b: number) => (s: string) => `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`;
const cyan = rgb(121, 192, 255);
const green = rgb(126, 231, 135);
const yellow = rgb(227, 179, 65);
const magenta = rgb(210, 168, 255);
const underline = SGR(4, 24);
const white = rgb(240, 246, 255);
const muted = rgb(139, 148, 158);
const sand = rgb(230, 211, 163);
const bg = (r: number, g: number, b: number) => (s: string) => `\x1b[48;2;${r};${g};${b}m${s}\x1b[49m`;
const chipBg = bg(31, 41, 55); // inline code, pills
const codeBg = bg(22, 27, 34); // fenced code, table header
const noteBg = bg(28, 26, 16); // callouts
const KW = /^(?:const|let|var|function|return|if|else|for|while|import|export|from|class|new|await|async|true|false|null|undefined|def|self|None|True|False|type|interface|extends|try|catch|throw|in|of|as|fn|pub|use|struct|impl|match|elif|with|yield|lambda)$/;
/** Light syntax colors for one code line: strings green, numbers amber, keywords purple, comments muted. */
export function highlight(line: string): string {
  const comment = /(\/\/.*|#(?![\w{]).*|--\s.*)$/.exec(line);
  const code = comment ? line.slice(0, comment.index) : line;
  const body = code.replace(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`)|\b(\d+(?:\.\d+)?)\b|\b([A-Za-z_]\w*)\b/g, (m, str?: string, num?: string, word?: string) =>
    str ? green(str) : num ? yellow(num) : word && KW.test(word) ? magenta(word) : white(m));
  return body + (comment ? muted(comment[1]) : "");
}

/** pad an ANSI line to `w` visible columns (so a background fills the row) */
const padTo = (s: string, w: number) => s + " ".repeat(Math.max(0, w - visible(s).length));
const CALLOUT: Record<string, { icon: string; color: (s: string) => string }> = {
  NOTE: { icon: "ℹ", color: cyan }, TIP: { icon: "✦", color: green }, IMPORTANT: { icon: "◆", color: magenta },
  WARNING: { icon: "⚠", color: yellow }, CAUTION: { icon: "✗", color: rgb(255, 123, 114) },
};

/** OSC 8 terminal hyperlink — clickable in cmux/ghostty, iTerm2, kitty, wezterm, VS Code. */
export const link = (text: string, url: string) =>
  /[\x00-\x1f\x7f-\x9f]/.test(url) ? text : `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;

/** Untrusted text (model output): no ESC, no C0/C1 controls except tab and newline — styling is added after. */
export const stripControls = (s: string) => s.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");

const URL_RE = /\bhttps?:\/\/[^\s<>()\[\]"'`\x1b]+[^\s<>()\[\]"'`.,;:!?\x1b]/g;

/** Make bare URLs clickable. Skips text that already carries OSC 8 links. */
export function linkify(s: string): string {
  if (s.includes("\x1b]8;")) return s;
  return s.replace(URL_RE, (u) => link(underline(cyan(u)), u));
}

const CITE_RE = /\[\[(\d+)\]\]\((https?:[^)\s]+)\)/g;
const MDLINK_RE = /\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g;

/**
 * Links in text that is ALREADY styled (tachibot's own ANSI output): citations
 * `[[5]](url)` → a clickable `[5]`, `[text](url)` → clickable text, bare URLs
 * clickable. Escape-aware — only the text between SGR sequences is touched, so
 * tachibot's colors are never broken. The visible label stays when a terminal
 * has no OSC 8 support.
 */
export function linkifyAnsi(s: string): string {
  if (s.includes("\x1b]8;")) return s;
  return s
    .split(/(\x1b\[[0-9;]*m)/)
    .map((part, i) => {
      if (i % 2) return part; // an SGR sequence
      const done: string[] = [];
      const keep = (x: string) => `\u0001${done.push(x) - 1}\u0001`;
      part = part
        .replace(CITE_RE, (_, n: string, u: string) => keep(link(cyan(`[${n}]`), u)))
        .replace(MDLINK_RE, (_, t: string, u: string) => keep(link(underline(cyan(t)), u)));
      return linkify(part).replace(/\u0001(\d+)\u0001/g, (_, k: string) => done[Number(k)]);
    })
    .join("");
}

/** Inline spans: `code`, **bold**, *italic*, [[n]](url) citations, [text](url). */
export function inline(s: string): string {
  const codes: string[] = [];
  // protect code spans first so `**` inside code stays literal
  s = s.replace(/`([^`\n]+)`/g, (_, c: string) => `\u0000${codes.push(c) - 1}\u0000`);
  s = s
    .replace(/\*\*([^*\n]+)\*\*|__([^_\n]+)__/g, (_, a?: string, b?: string) => bold(white(a ?? b ?? "")))
    .replace(/(^|[\s(])\*([^*\s][^*\n]*)\*(?=[\s).,;:!?]|$)/g, (_, pre: string, t: string) => `${pre}${italic(t)}`)
    .replace(CITE_RE, (_, n: string, u: string) => `\u0001${link(cyan(`[${n}]`), u)}\u0001`)
    .replace(MDLINK_RE, (_, t: string, u: string) => `\u0001${link(underline(cyan(t)), u)}\u0001`);
  // bare URLs outside the [text](url) links just made
  s = s.split("\u0001").map((part, i) => (i % 2 ? part : linkify(part))).join("");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => chipBg(cyan(codes[Number(i)])));
}

/** What the terminal shows: SGR styling and OSC 8 link wrappers removed. */
export const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x07]*\x07/g, "");

function table(rows: string[], width: number): string[] {
  const cells = rows
    .filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r))
    .map((r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim())));
  const n = Math.max(...cells.map((r) => r.length));
  const w = Array.from({ length: n }, (_, i) => Math.max(...cells.map((r) => visible(r[i] ?? "").length)));
  const total = w.reduce((a, b) => a + b, 0) + 3 * n + 1;
  // too wide for the pane → one "header: value" block per row instead of a grid
  if (total > width) {
    const [head, ...body] = cells;
    const out: string[] = [];
    for (const r of body) {
      r.forEach((c, i) => out.push(...wrapAnsi(`${dim(visible(head[i] ?? ""))}: ${c}`, width, { hard: true }).split("\n")));
      out.push("");
    }
    return out;
  }
  const edge = (l: string, m: string, r: string) => muted(l + w.map((x) => "─".repeat(x + 2)).join(m) + r);
  const row = (r: string[], head: boolean) => {
    const cellsOut = w.map((x, i) => {
      const c = ` ${padTo(head ? muted(visible(r[i] ?? "")) : (r[i] ?? ""), x)} `;
      return head ? codeBg(c) : c;
    });
    return muted("│") + cellsOut.join(muted("│")) + muted("│");
  };
  return [edge("┌", "┬", "┐"), row(cells[0], true), edge("├", "┼", "┤"), ...cells.slice(1).map((r) => row(r, false)), edge("└", "┴", "┘")];
}

export function renderMarkdown(text: string, width: number): string[] {
  text = stripControls(text);
  const out: string[] = [];
  const emit = (s: string, indent = "") => {
    for (const l of wrapAnsi(s, Math.max(10, width - indent.length), { hard: true, trim: false }).split("\n")) out.push(indent + l);
  };
  const lines = text.replace(/\t/g, "  ").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trimEnd();
    const fence = /^\s*(```|~~~)\s*(\S*)/.exec(raw);
    if (fence) {
      const block = (s: string) => out.push(codeBg(padTo(` ${s}`, width)));
      if (fence[2]) block(muted(fence[2]));
      while (++i < lines.length && !/^\s*(```|~~~)/.test(lines[i])) {
        for (const l of wrapAnsi(highlight(lines[i].trimEnd()), Math.max(10, width - 2), { hard: true, trim: false }).split("\n")) block(l);
      }
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(raw)) {
      const rows = [raw];
      while (i + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[i + 1])) rows.push(lines[++i]);
      out.push(...table(rows, width));
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (h) {
      if (out.length && out[out.length - 1] !== "") out.push("");
      const t = inline(h[2].replace(/\s*#+$/, ""));
      if (h[1].length === 1) {
        // H1: bright title, a purple rule under it
        emit(bold(white(t)));
        out.push(magenta("━".repeat(Math.min(width, Math.max(8, visible(t).length)))));
      } else if (h[1].length === 2) emit(bold(magenta(`▍ ${t}`)));
      else emit(bold(cyan(`◆ ${t}`)));
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) {
      out.push(muted("─".repeat(width)));
      continue;
    }
    const q = /^\s*>\s?(.*)$/.exec(raw);
    if (q) {
      const kind = /^\[!(\w+)\]\s*(.*)$/.exec(q[1]);
      if (kind && CALLOUT[kind[1].toUpperCase()]) {
        // > [!WARNING] … : a tinted box with an icon title
        const c = CALLOUT[kind[1].toUpperCase()];
        const body = kind[2] ? [kind[2]] : [];
        while (i + 1 < lines.length && /^\s*>/.test(lines[i + 1])) body.push(lines[++i].replace(/^\s*>\s?/, ""));
        out.push(noteBg(padTo(` ${bold(c.color(`${c.icon} ${kind[1].toUpperCase()}`))}`, width)));
        for (const b of body) for (const l of wrapAnsi(inline(b), Math.max(10, width - 2), { hard: true }).split("\n")) out.push(noteBg(padTo(` ${sand(l)}`, width)));
        continue;
      }
      emit(italic(muted(inline(q[1]))), muted("│ "));
      continue;
    }
    const task = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(raw);
    if (task) {
      const pad = "  ".repeat(Math.floor(task[1].length / 2));
      const done = task[2] !== " ";
      const body = wrapAnsi(inline(task[3]), Math.max(10, width - pad.length - 2), { hard: true }).split("\n");
      body.forEach((l, j) => out.push(`${pad}${j === 0 ? (done ? green("✓") : muted("○")) : " "} ${done ? muted(l) : l}`));
      continue;
    }
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(raw);
    if (li) {
      const depth = Math.floor(li[1].length / 2);
      const mark = /\d/.test(li[2]) ? cyan(li[2]) : cyan(depth ? "◦" : "•");
      const pad = "  ".repeat(depth);
      const body = wrapAnsi(inline(li[3]), Math.max(10, width - pad.length - visible(li[2]).length - 1), { hard: true }).split("\n");
      body.forEach((l, j) => out.push(`${pad}${j === 0 ? mark : " ".repeat(visible(li[2]).length)} ${l}`));
      continue;
    }
    if (!raw.trim()) {
      if (out.length && out[out.length - 1] !== "") out.push("");
      continue;
    }
    emit(inline(raw));
  }
  return out;
}
