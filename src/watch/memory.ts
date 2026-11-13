/**
 * tachi-watch — what the reviewer checks Claude against. Gathers the project's
 * written-down decisions and memory, cut into paragraphs labelled `file:line`,
 * and picks the ones that overlap most with what's happening now — so the
 * watcher can say "CLAUDE.md:42 says X, but Claude just did Y".
 *
 * Sources (all optional, missing files skipped):
 *   <cwd>/CLAUDE.md, <cwd>/AGENTS.md
 *   ~/.claude/projects/<dir>/memory/*.md   (Claude Code auto-memory)
 *   <cwd>/.remember/now.md, <cwd>/.remember/recent.md
 *   config memory.files (relative to cwd)
 * plus dokoro recall when DOKORO_CMD is configured (see watch.ts).
 */
import fs from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative } from "node:path";
import { claudeProjectDir } from "./events.js";

export interface Snippet {
  /** `file:line` label as shown to the model and in the pane. */
  source: string;
  text: string;
}

export interface MemoryDoc {
  label: string;
  content: string;
}

export function memoryFiles(cwd: string, extra: string[] = [], home: string = homedir()): string[] {
  const files = [join(cwd, "CLAUDE.md"), join(cwd, "AGENTS.md"), join(cwd, ".remember", "now.md"), join(cwd, ".remember", "recent.md")];
  const memDir = join(home, ".claude", "projects", claudeProjectDir(cwd), "memory");
  try {
    for (const f of fs.readdirSync(memDir)) if (f.endsWith(".md")) files.push(join(memDir, f));
  } catch {
    // no auto-memory for this project
  }
  // dokoro's markdown in the project: the current focus, plus the newest daily/session notes
  // (plans written by planner_maker land in dokoro/daily) — read directly, not via its search index
  const dokoro = join(cwd, "dokoro");
  if (fs.existsSync(join(dokoro, "current.md"))) files.push(join(dokoro, "current.md"));
  const notes: Array<{ path: string; mtime: number }> = [];
  for (const sub of ["daily", "sessions"]) {
    try {
      for (const f of fs.readdirSync(join(dokoro, sub))) {
        if (!f.endsWith(".md")) continue;
        const path = join(dokoro, sub, f);
        notes.push({ path, mtime: fs.statSync(path).mtimeMs });
      }
    } catch {
      // no such dokoro folder
    }
  }
  for (const n of notes.sort((a, b) => b.mtime - a.mtime).slice(0, 6)) files.push(n.path);
  for (const f of extra) {
    // relative entries must resolve inside the project (symlinks included); absolute ones only come from ~/.tachi
    const p = isAbsolute(f) ? f : join(cwd, f);
    if (!isAbsolute(f)) {
      try {
        const real = fs.realpathSync(p);
        if (relative(fs.realpathSync(cwd), real).startsWith("..")) continue;
      } catch {
        continue;
      }
    }
    files.push(p);
  }
  return files;
}

export function readMemoryDocs(files: string[], cwd: string): MemoryDoc[] {
  const docs: MemoryDoc[] = [];
  for (const file of files) {
    try {
      const content = fs.readFileSync(file, "utf8");
      const rel = relative(cwd, file);
      docs.push({ label: rel.startsWith("..") ? `memory/${basename(file)}` : rel, content });
    } catch {
      // missing — skip
    }
  }
  return docs;
}

const STOP = new Set(["this", "that", "with", "from", "have", "will", "would", "should", "there", "their", "about", "which", "when", "what", "were", "been", "into", "then", "than", "only", "also", "just", "your", "they", "them", "some", "more", "true", "false", "null"]);

export function tokens(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of s.toLowerCase().split(/[^a-z0-9_.-]+/)) {
    const t = w.replace(/^[.-]+|[.-]+$/g, "");
    if (t.length >= 4 && !STOP.has(t)) out.add(t);
  }
  return out;
}

/** Split a doc into paragraphs (blank-line or heading separated) with 1-based start lines. */
export function paragraphs(doc: MemoryDoc): Array<{ line: number; text: string }> {
  const lines = doc.content.split("\n");
  const out: Array<{ line: number; text: string }> = [];
  let start = -1;
  let buf: string[] = [];
  const flush = () => {
    const text = buf.join("\n").trim();
    if (text) out.push({ line: start + 1, text });
    buf = [];
    start = -1;
  };
  lines.forEach((l, i) => {
    if (!l.trim() || /^#{1,6}\s/.test(l)) flush();
    if (l.trim()) {
      if (start < 0) start = i;
      buf.push(l);
    }
  });
  flush();
  return out;
}

/** Top-k paragraphs by word overlap with `query` (ties → shorter, more specific paragraph). */
export function selectSnippets(docs: MemoryDoc[], query: string, k: number, maxChars = 500): Snippet[] {
  const q = tokens(query);
  if (q.size === 0) return [];
  const scored: Array<{ score: number; len: number; snip: Snippet }> = [];
  for (const doc of docs) {
    for (const p of paragraphs(doc)) {
      let hits = 0;
      for (const t of tokens(p.text)) if (q.has(t)) hits++;
      if (hits >= 2) {
        const text = p.text.length > maxChars ? `${p.text.slice(0, maxChars - 1)}…` : p.text;
        scored.push({ score: hits, len: p.text.length, snip: { source: `${doc.label}:${p.line}`, text } });
      }
    }
  }
  scored.sort((a, b) => b.score - a.score || a.len - b.len);
  return scored.slice(0, k).map((s) => s.snip);
}
