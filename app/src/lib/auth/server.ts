"use server";

import { getCurrentUser } from "~/lib/auth/session";
import { requireAllowedEmail, isEmailAllowed } from "~/lib/auth/allowList";
import type { AuthUser } from "~/lib/auth/types";

/**
 * Retrieve + authorize the authenticated user for a protected server function.
 * Call at the top of any server action that must run as a real user. Enforces
 * the email allow-list. Throws when unauthenticated or unauthorized.
 *
 * This is the single server-side identity choke point: the identity source is
 * now Entra (`session.ts`), but the return shape is unchanged so all callers
 * (`actions.server.ts`, stash, events, pty, …) keep working untouched.
 */
export async function getAuthenticatedUser(): Promise<AuthUser> {
  "use server";

  const user = await getCurrentUser();
  if (!user) {
    throw new Error("Authentication required: No user found in session.");
  }
  if (!user.email) {
    throw new Error("Authentication required: User has no email address.");
  }
  requireAllowedEmail(user.email);
  return user;
}

/**
 * Non-throwing variant for the client `AuthProvider` resource: returns the
 * user when there's a valid, allow-listed session, else `null`. Never throws —
 * the provider treats `null` as "redirect to sign-in".
 */
export async function getSessionUser(): Promise<AuthUser | null> {
  "use server";

  try {
    const user = await getCurrentUser();
    if (!user || !user.email || !isEmailAllowed(user.email)) return null;
    return user;
  } catch {
    return null;
  }
}
