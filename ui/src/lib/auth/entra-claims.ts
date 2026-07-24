/**
 * Entra ID-token claim handling — pure, no server-only or MSAL imports.
 *
 * Split out from `entra.server.ts` (which pulls in `@azure/msal-node`) so the
 * "mocked token" mapping — the security-critical bit — can be unit-tested in
 * isolation (mirrors how `replay.ts` was extracted from `actions.server.ts`).
 */

/** Subset of Entra ID-token claims we consume. */
export interface EntraIdTokenClaims {
  /** Immutable per-user object id in the tenant — our stable `userId`. */
  oid?: string;
  /** Email; work accounts may only populate `preferred_username`. */
  email?: string;
  preferred_username?: string;
  name?: string;
  /** Tenant id. */
  tid?: string;
}

export interface EntraIdentity {
  /** Entra `oid`. */
  userId: string;
  email: string;
  displayName: string | null;
  tenantId: string | null;
}

/**
 * Normalize + validate ID-token claims into our identity shape. Throws when
 * `oid` or a usable email is absent (a token we can't key a user on). Email
 * falls back to `preferred_username` (the UPN) which work accounts always set.
 */
export function extractIdentity(
  claims: EntraIdTokenClaims | undefined | null,
): EntraIdentity {
  const oid = claims?.oid?.trim();
  if (!oid) {
    throw new Error(
      "[entra] ID token has no `oid` claim — cannot derive a stable userId.",
    );
  }
  const email = (claims?.email || claims?.preferred_username || "").trim();
  if (!email) {
    throw new Error(
      "[entra] ID token has neither `email` nor `preferred_username`.",
    );
  }
  return {
    userId: oid,
    email,
    displayName: claims?.name?.trim() || null,
    tenantId: claims?.tid?.trim() || null,
  };
}
