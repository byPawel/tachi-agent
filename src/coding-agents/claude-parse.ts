// src/coding-agents/claude-parse.ts
/**
 * Interprets the single result envelope that Claude Code headless
 * (`claude -p --output-format json`) writes to stdout. The quirk that makes
 * this module exist: in review runs (`--permission-mode plan`) the `result`
 * field is a permission-denial string, and the actual plan markdown lives in
 * `permission_denials[].tool_input.plan` on the ExitPlanMode entry. In write
 * runs `result` IS the answer, and any denials that do appear mean the worker
 * silently degraded (headless denies Bash-class calls) — the caller surfaces
 * that as "N tool calls denied". Never throws; unparseable stdout fails
 * closed as an error with the raw output preserved.
 */
export interface ClaudeParsed {
  text: string | null;      // extracted plan (review) or result (write/fallback)
  isError: boolean;         // is_error === true, or unparseable stdout
  deniedCalls: number;      // permission_denials.length (0 when absent/malformed)
  sessionId?: string;       // session_id when a non-empty string (future --resume)
  numTurns?: number;        // num_turns when a finite number
  raw: string;              // original stdout, always preserved
}

interface DenialShape {
  tool_name?: unknown;
  tool_input?: { plan?: unknown } | null;
}

/** First ExitPlanMode denial carrying a non-blank plan string, else null. */
function findPlan(denials: unknown[]): string | null {
  for (const entry of denials) {
    const d = entry as DenialShape | null | undefined;
    const plan = d?.tool_input?.plan;
    if (d?.tool_name === "ExitPlanMode" && typeof plan === "string" && plan.trim() !== "") {
      return plan;
    }
  }
  return null;
}

export function parseClaudeEnvelope(stdout: string): ClaudeParsed {
  const raw = stdout ?? "";
  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return { text: null, isError: true, deniedCalls: 0, raw };
  }
  // Live CLIs (observed on 2.1.x) emit a JSON ARRAY of stream events whose
  // last {"type":"result"} entry is the envelope; older docs describe the bare
  // envelope. Accept both; an array without a result entry fails closed.
  if (Array.isArray(envelope)) {
    let resultEntry: unknown = null;
    for (let i = envelope.length - 1; i >= 0; i -= 1) {
      const e = envelope[i] as { type?: unknown } | null | undefined;
      if (e && typeof e === "object" && e.type === "result") { resultEntry = e; break; }
    }
    envelope = resultEntry;
  }
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) {
    return { text: null, isError: true, deniedCalls: 0, raw };
  }

  const env = envelope as {
    is_error?: unknown;
    result?: unknown;
    session_id?: unknown;
    num_turns?: unknown;
    permission_denials?: unknown;
  };

  const denials = Array.isArray(env.permission_denials) ? env.permission_denials : [];
  const plan = findPlan(denials);
  const text = plan ?? (typeof env.result === "string" && env.result !== "" ? env.result : null);

  const parsed: ClaudeParsed = {
    text,
    isError: env.is_error === true,
    deniedCalls: denials.length,
    raw,
  };
  if (typeof env.session_id === "string" && env.session_id !== "") {
    parsed.sessionId = env.session_id;
  }
  if (typeof env.num_turns === "number" && Number.isFinite(env.num_turns)) {
    parsed.numTurns = env.num_turns;
  }
  return parsed;
}
