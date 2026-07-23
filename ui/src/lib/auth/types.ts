/**
 * Auth types shared across the server (session read) and client (AuthProvider,
 * UserMenu). Kept in a pure module — no `"use server"`, no server-only imports —
 * so importing it from client components pulls in nothing but types.
 */

/** The normalized authenticated user, keyed on the Entra `oid` (`id`). */
export interface AuthUser {
  /** Entra `oid` — the stable per-user id everything downstream keys on. */
  id: string;
  email: string;
  displayName: string | null;
  /** Not populated by the Entra flow today; kept for UI compatibility. */
  profileImageUrl?: string | null;
}
