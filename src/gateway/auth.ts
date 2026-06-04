import { timingSafeEqual } from "node:crypto";

export interface Tenant {
  tenant: string;
}

/** Extract a bearer token from an Authorization header (case-insensitive scheme). */
export function parseBearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

/** Constant-time string compare (length-guarded; avoids token-oracle timing leaks). */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Resolve a tenant from a token.
 *  - GATEWAY_TOKENS="alice:tokA,bob:tokB" → multi-tenant (token may contain ':')
 *  - GATEWAY_TOKEN="tok"                  → single tenant "default"
 * Returns null if the token is absent or unmatched. Comparisons are constant-time.
 */
export function resolveTenant(
  token: string | null,
  env: { GATEWAY_TOKENS?: string; GATEWAY_TOKEN?: string },
): Tenant | null {
  if (!token) return null;
  if (env.GATEWAY_TOKENS) {
    for (const pair of env.GATEWAY_TOKENS.split(",")) {
      const i = pair.indexOf(":"); // split on FIRST colon only — tokens may contain ':'
      if (i < 0) continue;
      const tenant = pair.slice(0, i).trim();
      const tok = pair.slice(i + 1).trim();
      if (tok && safeEqual(tok, token)) return { tenant };
    }
    return null;
  }
  if (env.GATEWAY_TOKEN && safeEqual(env.GATEWAY_TOKEN, token)) return { tenant: "default" };
  return null;
}
