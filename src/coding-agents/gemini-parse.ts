// src/coding-agents/gemini-parse.ts
/**
 * Parser + tamper guard for gemini CLI headless `--output-format json` output.
 * Gemini's `--approval-mode plan` auto-flips to YOLO after plan-exit, so a
 * "read-only" review worker may have edited files or run shell commands behind
 * our back. reviewGuard is the fail-closed tripwire: any file-line delta or any
 * mutating/shell tool in the stats invalidates the review. Worktree isolation
 * is the separate backstop layer, which is why absent stats pass here.
 */
export interface GeminiParsed {
  response: string | null;
  stats?: {
    models?: Record<string, unknown>;
    tools?: { totalCalls?: number; byName?: Record<string, unknown> };
    files?: { totalLinesAdded?: number; totalLinesRemoved?: number };
  };
  error?: { type?: string; message?: string; code?: number };
  raw: string;
}

/** Tool-name fragments that prove the worker was NOT read-only. */
const MUTATING_TOOL_FRAGMENTS = ["shell", "run_shell", "bash", "write", "edit", "replace"];

/** Parse gemini's single-JSON-object stdout. Never throws; raw is always preserved. */
export function parseGeminiJson(stdout: string): GeminiParsed {
  const raw = stdout ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { response: null, raw };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { response: null, raw };
  }
  const obj = parsed as Record<string, unknown>;
  const out: GeminiParsed = {
    response: typeof obj.response === "string" && obj.response.length > 0 ? obj.response : null,
    raw,
  };
  if (obj.stats !== null && typeof obj.stats === "object") {
    out.stats = obj.stats as GeminiParsed["stats"];
  }
  if (obj.error !== null && typeof obj.error === "object") {
    out.error = obj.error as GeminiParsed["error"];
  }
  return out;
}

/**
 * Did a supposedly read-only review run stay read-only? ok:false means the
 * stats contain positive evidence of mutation. Missing stats are NOT evidence
 * (the worktree layer covers that), so they pass with an explicit reason.
 */
export function reviewGuard(p: GeminiParsed): { ok: boolean; reason?: string } {
  const stats = p.stats;
  if (!stats) return { ok: true, reason: "no stats present" };

  const added = stats.files?.totalLinesAdded;
  const removed = stats.files?.totalLinesRemoved;
  if (typeof added === "number" && added > 0) {
    return { ok: false, reason: `stats.files.totalLinesAdded=${added} — worker modified file lines` };
  }
  if (typeof removed === "number" && removed > 0) {
    return { ok: false, reason: `stats.files.totalLinesRemoved=${removed} — worker modified file lines` };
  }

  const byName = stats.tools?.byName;
  if (byName !== null && typeof byName === "object") {
    for (const name of Object.keys(byName)) {
      const lower = name.toLowerCase();
      if (MUTATING_TOOL_FRAGMENTS.some((frag) => lower.includes(frag))) {
        return { ok: false, reason: `mutating tool "${name}" appears in stats.tools.byName` };
      }
    }
  }
  return { ok: true };
}
