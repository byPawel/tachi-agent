/**
 * tachi-watch config — layered, later wins:
 *   defaults → ~/.tachi/watch.json → <project>/.tachi/watch.json → env
 *
 *   {
 *     "brain": "codex",               // claude|codex|gemini|grok|driver[:model]
 *     "review": { "everyToolCalls": 8, "minIntervalSec": 45, "repeatThreshold": 3 },
 *     "memory": { "files": ["docs/DECISIONS.md"], "maxSnippets": 8, "dokoroCmd": "node …/dokoro/dist/esm/servers/unified-server.js" },
 *     "maxCards": 200,
 *     "layout": "auto"                // auto (split at ≥140 cols) | split (calls · card · chat) | stack
 *   }
 *
 * Env: TACHI_WATCH_BRAIN overrides `brain`.
 */
import fs from "node:fs";
import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import type { ReviewPolicy } from "./policy.js";

export type WatchLayout = "auto" | "split" | "stack";
export const isLayout = (v: unknown): v is WatchLayout => v === "auto" || v === "split" || v === "stack";

export interface WatchConfig {
  brain: string;
  review: ReviewPolicy;
  memory: { files: string[]; maxSnippets: number; dokoroCmd?: string };
  maxCards: number;
  layout: WatchLayout;
  mouse: boolean;
  /** Which files contributed, for the pane header. */
  loadedFrom: string[];
}

/**
 * Default brain is Codex: a different model family from the Claude session it
 * watches, so it doesn't share Claude's blind spots or find its reasoning
 * plausible by default.
 */
export const DEFAULT_CONFIG: WatchConfig = {
  brain: "codex",
  review: { everyToolCalls: 8, minIntervalMs: 45_000, repeatThreshold: 3 },
  memory: { files: [], maxSnippets: 8 },
  maxCards: 200,
  layout: "auto",
  mouse: true,
  loadedFrom: [],
};

interface RawConfig {
  brain?: unknown;
  review?: { everyToolCalls?: unknown; minIntervalSec?: unknown; repeatThreshold?: unknown };
  memory?: { files?: unknown; maxSnippets?: unknown; dokoroCmd?: unknown };
  maxCards?: unknown;
  layout?: unknown;
  mouse?: unknown;
}

const posInt = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;

/** Merge one raw (untrusted JSON) layer onto a config. Bad values are ignored, not fatal. */
export function mergeConfig(base: WatchConfig, raw: RawConfig, source: string, trusted = true): WatchConfig {
  // a project's .tachi/watch.json comes with the repo: it may not run commands, and its memory
  // files must stay inside the project (they are read and sent to the brain)
  const files = (Array.isArray(raw.memory?.files) ? raw.memory.files.filter((f): f is string => typeof f === "string") : [])
    .filter((f) => trusted || (!isAbsolute(f) && !f.split(/[\\/]/).includes("..")));
  const minSec = posInt(raw.review?.minIntervalSec);
  return {
    brain: typeof raw.brain === "string" && raw.brain.trim() ? raw.brain.trim() : base.brain,
    review: {
      everyToolCalls: posInt(raw.review?.everyToolCalls) ?? base.review.everyToolCalls,
      minIntervalMs: minSec !== undefined ? minSec * 1000 : base.review.minIntervalMs,
      repeatThreshold: posInt(raw.review?.repeatThreshold) ?? base.review.repeatThreshold,
    },
    memory: {
      files: [...base.memory.files, ...files],
      maxSnippets: posInt(raw.memory?.maxSnippets) ?? base.memory.maxSnippets,
      dokoroCmd: trusted && typeof raw.memory?.dokoroCmd === "string" && raw.memory.dokoroCmd.trim() ? raw.memory.dokoroCmd.trim() : base.memory.dokoroCmd,
    },
    maxCards: posInt(raw.maxCards) ?? base.maxCards,
    layout: isLayout(raw.layout) ? raw.layout : base.layout,
    mouse: typeof raw.mouse === "boolean" ? raw.mouse : base.mouse,
    loadedFrom: [...base.loadedFrom, source],
  };
}

function readJson(file: string): RawConfig | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as RawConfig;
  } catch {
    return undefined; // missing or invalid → layer skipped
  }
}

export function loadWatchConfig(
  cwd: string,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): WatchConfig {
  let cfg = DEFAULT_CONFIG;
  const homeFile = join(home, ".tachi", "watch.json");
  for (const file of [homeFile, join(cwd, ".tachi", "watch.json")]) {
    const raw = readJson(file);
    if (raw) cfg = mergeConfig(cfg, raw, file, file === homeFile);
  }
  if (env.TACHI_WATCH_BRAIN?.trim()) cfg = { ...cfg, brain: env.TACHI_WATCH_BRAIN.trim(), loadedFrom: [...cfg.loadedFrom, "env"] };
  return cfg;
}
