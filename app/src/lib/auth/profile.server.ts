/**
 * Profile page — server action.
 *
 * One round trip behind `/profile`: who the caller is, and which inference
 * tier their chats run on. Nothing else — this is a preview profile page, not
 * an account system.
 *
 * ## The gate, and why it is a copy
 *
 * Every export of a `'use server'` module is an RPC the browser can call, so
 * the single export below is gated before any resource is opened.
 * `requireUser()` is duplicated here rather than imported for the reason the
 * copies in `harness-client/actions.server.ts`, `metrics/dashboard.server.ts`
 * and `harness-client/preview-header.server.ts` exist: a `'use server'` file
 * cannot export a shared helper without also exporting it as an RPC.
 *
 * **The export takes no arguments at all.** The owner is resolved from the
 * session inside it, so there is no parameter a caller could use to read
 * somebody else's name, mail address or preference — the same contract that
 * keeps `db/user-prefs.server.ts` and `auth/users.server.ts` off the
 * `'use server'` surface.
 *
 * ## The encrypted columns
 *
 * `users.email` / `users.display_name` are encrypted at rest, and the seam is
 * the repository module that owns the table. This file therefore reads through
 * `getUser()` and writes no SQL of its own — `encryption-coverage.test.ts` is
 * the pin that keeps it that way, and adding a statement here instead would be
 * a bypass rather than a shortcut.
 */
'use server'

import { getAuthenticatedUser } from './server'
import { BYPASS_USER, isBypassEnabled } from './dev-bypass'
import { getUser } from './users.server'
import { getStoredInferenceTier } from '../db/user-prefs.server'
import { resolveTier } from '../inference/tier.server'
import type { InferenceTier } from '../harness-patterns/clients.server'

async function requireUser(): Promise<{ id: string; email: string; displayName: string | null }> {
  if (isBypassEnabled()) {
    return { id: BYPASS_USER.id, email: BYPASS_USER.email, displayName: 'Dev User' }
  }
  const u = await getAuthenticatedUser()
  return { id: u.id, email: u.email, displayName: u.displayName ?? null }
}

/** What `/profile` renders. Epoch millis rather than `Date`, so the payload
 *  survives the RPC boundary as itself. */
export interface ProfileView {
  email: string
  displayName: string | null
  /** First and last observed sign-in, from the `users` row. Null when there is
   *  no row yet — the dev bypass never writes one, and neither does a session
   *  that predates the table. */
  firstLogin: number | null
  lastLogin: number | null
  /** The tier this user's NEXT NEW chat starts on: their last-used choice,
   *  else the deployment's default. Read through `resolveTier` — the one
   *  resolver the turn runner and the conversation switch also go through, so
   *  this page cannot show a tier the run does not take. It is the SEED and not
   *  a per-conversation answer: every thread now carries its own tier, which is
   *  its row's business and not this page's. */
  tier: InferenceTier
}

/** The signed-in caller's own profile. Takes no owner id — see the module note. */
export async function getProfile(): Promise<ProfileView> {
  const caller = await requireUser()
  // The durable record is the `users` row (refreshed from Entra at every
  // sign-in). The session's own snapshot is the fallback, not the primary: a
  // bypassed dev user has no row at all.
  const [record, seed] = await Promise.all([getUser(caller.id), getStoredInferenceTier(caller.id)])
  // No conversation to ask about here, so the seed decides — `resolveTier`
  // falls to the deployment default when there is not even one of those.
  const tier = resolveTier(null, seed)
  return {
    email: record?.email ?? caller.email,
    displayName: record?.displayName ?? caller.displayName,
    firstLogin: record?.firstLogin?.getTime() ?? null,
    lastLogin: record?.lastLogin?.getTime() ?? null,
    tier,
  }
}
