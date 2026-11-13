/**
 * tachi-watch — resume. The brain's notes and answers (with the questions you
 * asked) are saved per Claude session to ~/.tachi/watch/sessions/<session>.json
 * and restored when the pane restarts. Calls are not saved: they replay from
 * Claude's transcript, and saved notes re-attach to them by tool_use id.
 */
import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Card } from "./store.js";

const KEEP = 300;

export function sessionFile(session: string, home: string = homedir()): string {
  return join(home, ".tachi", "watch", "sessions", `${session.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
}

export function loadSaved(session: string, home?: string): Card[] {
  try {
    const raw = JSON.parse(fs.readFileSync(sessionFile(session, home), "utf8")) as { cards?: unknown };
    return Array.isArray(raw.cards) ? (raw.cards as Card[]).filter((c) => c && (c.type === "note" || c.type === "answer")) : [];
  } catch {
    return [];
  }
}

export function saveCards(session: string, cards: Card[], home?: string): void {
  const keep = cards.filter((c) => c.source === "watch" && (c.type === "note" || c.type === "answer")).slice(-KEEP);
  try {
    const file = sessionFile(session, home);
    fs.mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ savedAt: Date.now(), cards: keep }), { mode: 0o600 });
  } catch {
    // resume is a convenience — never break the pane over it
  }
}

/** Your own names for question groups, keyed by the prompt's timestamp: ~/.tachi/watch/labels/<session>.json */
export function labelsFile(session: string, home: string = homedir()): string {
  return join(home, ".tachi", "watch", "labels", `${session.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
}

export function loadLabels(session: string, home?: string): Record<string, string> {
  try {
    const raw = JSON.parse(fs.readFileSync(labelsFile(session, home), "utf8")) as unknown;
    return raw && typeof raw === "object" ? (raw as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function saveLabels(session: string, labels: Record<string, string>, home?: string): void {
  const file = labelsFile(session, home);
  fs.mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(labels, null, 2), { mode: 0o600 });
}
