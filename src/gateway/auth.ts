// src/gateway/auth.ts
export interface Tenant {
  tenant: string;
}

/** Extract a bearer token from an Authorization header (case-insensitive scheme). */
export function parseBearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

/**
 * Resolve a tenant from a token.
 *  - GATEWAY_TOKENS="alice:tokA,bob:tokB" → multi-tenant
 *  - GATEWAY_TOKEN="tok"                  → single tenant "default"
 * Returns null if the token is absent or unmatched.
 */
export function resolveTenant(
  token: string | null,
  env: { GATEWAY_TOKENS?: string; GATEWAY_TOKEN?: string },
): Tenant | null {
  if (!token) return null;
  if (env.GATEWAY_TOKENS) {
    for (const pair of env.GATEWAY_TOKENS.split(",")) {
      const [tenant, tok] = pair.split(":").map((s) => s.trim());
      if (tok && tok === token) return { tenant };
    }
    return null;
  }
  if (env.GATEWAY_TOKEN && token === env.GATEWAY_TOKEN) return { tenant: "default" };
  return null;
}
