"use server";

import { getRequestEvent } from "solid-js/web";
import { getSession } from "./session-store.server";
import { readCookie, SESSION_COOKIE } from "./cookies.server";
import type { AuthUser } from "./types";

/**
 * Read the current authenticated user from the server-side Entra session:
 * the opaque `kg_session` cookie → a Postgres `auth_sessions` row. Returns
 * `null` when there is no valid, unexpired session.
 *
 * Replaces the former Stack Auth lookup (#119). The identity *source* changed
 * (Stack → Entra); the `{ id, email, displayName }` shape did not, so every
 * downstream consumer (via `getAuthenticatedUser`) is unaffected. `id` is the
 * Entra `oid`.
 */
export async function getCurrentUser(): Promise<AuthUser | null> {
  "use server";

  const event = getRequestEvent();
  if (!event) {
    console.error(
      "[getCurrentUser] No request event found. This must be called within a server context.",
    );
    return null;
  }

  const sessionId = readCookie(event.request, SESSION_COOKIE);
  const session = await getSession(sessionId);
  if (!session) return null;

  return {
    id: session.userId,
    email: session.email,
    displayName: session.displayName,
  };
}
