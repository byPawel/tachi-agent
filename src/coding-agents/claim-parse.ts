// src/coding-agents/claim-parse.ts
/**
 * Fail-closed interpretation of dokoro_file_claim output. callInternal joins the
 * tool's text blocks with "\n", so the machine-readable {claimed,report} object
 * is one of the lines. We parse THAT, never the prose. If we cannot positively
 * find claimed:true, we report NOT claimed — an error, a reworded message, or a
 * partial acquisition must never be mistaken for an exclusive lease.
 */
export interface ClaimOutcome {
  claimed: boolean;
  conflict: boolean;
  report: unknown[];
  raw: string;
}

/** Extract the last balanced JSON object containing a "claimed" key. */
function findClaimJson(raw: string): { claimed?: unknown; report?: unknown } | undefined {
  for (const line of raw.split(/\r?\n/).reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.includes("\"claimed\"")) continue;
    try {
      const obj = JSON.parse(trimmed) as { claimed?: unknown; report?: unknown };
      if (typeof obj.claimed === "boolean") return obj;
    } catch { /* keep scanning older lines */ }
  }
  return undefined;
}

export function parseClaimResult(raw: string): ClaimOutcome {
  const parsed = findClaimJson(raw ?? "");
  if (!parsed) {
    // No machine-readable verdict → we do not know we hold anything. Fail closed.
    return { claimed: false, conflict: false, report: [], raw: raw ?? "" };
  }
  const report = Array.isArray(parsed.report) ? parsed.report : [];
  const claimed = parsed.claimed === true;
  const conflict = !claimed && report.some(
    (r) => r !== null && typeof r === "object" && (r as { status?: unknown }).status === "conflict",
  );
  return { claimed, conflict, report, raw };
}
