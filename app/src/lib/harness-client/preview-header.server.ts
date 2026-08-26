/**
 * Preview header — server actions.
 *
 * The one round trip behind the top-bar strip: which inference tier the
 * signed-in user's chats run on, whether the self-hosted box is warm, and a few
 * global counters. One action rather than three, because the strip refreshes on
 * a timer and three polls would be three connections for one row of numbers.
 *
 * ## The gate, and why it is a copy
 *
 * Every export of a `'use server'` module is an RPC the browser can call, so
 * each one below is gated. `requireUser()` is duplicated here rather than
 * imported from `actions.server.ts` for the reason that module's own copy
 * exists: a `'use server'` file cannot export a shared helper without also
 * exporting it as an RPC. The gate returns before any resource is opened.
 *
 * **No function here takes an owner id.** The owner is resolved from the
 * session inside each action; a `userId` parameter would let the caller choose
 * whose preference to read or write, which is the whole reason
 * `db/user-prefs.server.ts` is deliberately not a `'use server'` module.
 */
'use server'

import { getAuthenticatedUser } from '../auth/server'
import { BYPASS_USER, isBypassEnabled } from '../auth/dev-bypass'
import {
  defaultInferenceTier,
  getStoredInferenceTier,
  isInferenceTier,
  setStoredInferenceTier,
} from '../db/user-prefs.server'
import { verdaConfigured, type InferenceTier } from '../harness-patterns/clients.server'
import { verdaWarmth, type VerdaWarmth } from '../inference/verda-activity.server'
import { ACTIVE_WINDOW_MINUTES, countActiveUsers } from '../db/conversations.server'
import { getUsageToday, type UsageToday } from '../metrics/preview-counters.server'
import { tierLatency, type TierLatency } from '../metrics/call-latency.server'

async function requireUser(): Promise<{ id: string }> {
  if (isBypassEnabled()) return { id: BYPASS_USER.id }
  const u = await getAuthenticatedUser()
  return { id: u.id }
}

/** Everything the header strip renders, in one payload. */
export interface PreviewHeaderState {
  /** The tier this user's next turn will run on. */
  tier: InferenceTier
  /** False when the endpoint is unconfigured — the switch renders its Verda
   *  position disabled rather than offering a choice that would throw. */
  verdaAvailable: boolean
  warmth: VerdaWarmth
  /** Distinct users with chat activity in the last {@link activeWindowMinutes}
   *  minutes. */
  activeUsers: number
  activeWindowMinutes: number
  usage: UsageToday
  /** Rolling median duration of recent model calls **on `tier`** — the tier
   *  this user's next turn will run on, so the switch above it and the number
   *  beside it describe the same thing. Over the roles a tier decision actually
   *  moves and no others, which is what makes the figure comparable with the
   *  other switch position; the tooltip says so. Process-local, with the same
   *  multi-instance caveat as `warmth` (`metrics/call-latency.server.ts`). */
  latency: TierLatency
  /** When the server computed this payload. Informational: the strip ticks its
   *  countdown against its OWN receipt time, because subtracting a server stamp
   *  from a client `Date.now()` would measure clock skew as well as elapsed
   *  time (`preview-header-format.ts`, `remainingSeconds`). */
  generatedAt: number
}

/** The strip's whole payload. Cheap by construction: two indexed reads and two
 *  process-local readings (the warm clock and the latency window) — no event
 *  blob is opened, which is what makes it safe to poll. "Indexed" is
 *  load-bearing for the active-user read and was not true when this shipped: it
 *  needs `conversations_updated_idx` (`db/client.server.ts`), the only index on
 *  that table that leads on `updated_at`. */
export async function getPreviewHeaderState(): Promise<PreviewHeaderState> {
  const user = await requireUser()
  const [stored, activeUsers, usage] = await Promise.all([
    getStoredInferenceTier(user.id),
    countActiveUsers(),
    getUsageToday(),
  ])
  const tier = stored ?? defaultInferenceTier()
  return {
    tier,
    verdaAvailable: verdaConfigured(),
    warmth: verdaWarmth(),
    activeUsers,
    activeWindowMinutes: ACTIVE_WINDOW_MINUTES,
    usage,
    // Read for the ACTIVE tier, and after it is resolved: the latency of a tier
    // the user is not on answers a question nobody asked, and the strip has one
    // slot for it.
    latency: tierLatency(tier),
    generatedAt: Date.now(),
  }
}

/**
 * Store this user's tier choice and return the state the header should now
 * show, so the control settles on server truth rather than on its own
 * optimistic guess.
 *
 * Rejects `'verda'` when the endpoint is unconfigured. That refusal matters
 * more than it looks: accepting it would store a preference that
 * `runWithInferenceTier` throws on, turning a header click into a broken chat
 * on the user's next message — and the one thing that must never happen
 * instead, a quiet fall-through to Anthropic, is refused by design upstream.
 */
export async function setPreviewInferenceTier(tier: unknown): Promise<PreviewHeaderState> {
  const user = await requireUser()
  if (!isInferenceTier(tier)) {
    throw new Error(`Unknown inference tier: ${JSON.stringify(tier)}`)
  }
  if (tier === 'verda' && !verdaConfigured()) {
    throw new Error(
      'The self-hosted inference endpoint is not configured on this deployment, so it cannot ' +
        'be selected. Set VERDA_INFERENCE_ENDPOINT and VERDA_INFERENCE_API_KEY (see ' +
        'app/.env.example).',
    )
  }
  await setStoredInferenceTier(user.id, tier)
  return getPreviewHeaderState()
}
