/**
 * Preview header — server actions.
 *
 * The one round trip behind the top-bar strip: whether the self-hosted box is
 * warm, a few global counters, and the latency of the tier a NEW chat starts
 * on. One action rather than three, because the strip refreshes on a timer and
 * three polls would be three connections for one row of numbers.
 *
 * **It no longer CHANGES the tier.** That control moved beside the agent
 * selector and became per-conversation (`harness-client/actions.server.ts`'s
 * `setConversationTier`), because the thing people want is to start an
 * Anthropic chat while a private one is still waking — which one global setting
 * cannot express. What is left here describes the BOX and the deployment, not a
 * conversation: nothing in this payload can disagree with the switch, because
 * nothing in it is a per-conversation claim.
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
import { defaultInferenceTier, getStoredInferenceTier } from '../db/user-prefs.server'
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
  /**
   * The tier a NEW chat starts on — this user's last-used, else the deployment
   * default. Not "the tier your next message runs on": since the switch became
   * per-conversation that is a property of whichever thread is open, and the
   * strip does not know which one that is. It is here for the latency figure
   * below, which has to name the tier it measured.
   */
  tier: InferenceTier
  /** False when the endpoint is unconfigured. Gates the warm indicator: a
   *  countdown for a box this deployment cannot reach is noise. */
  verdaAvailable: boolean
  warmth: VerdaWarmth
  /** Distinct users with chat activity in the last {@link activeWindowMinutes}
   *  minutes. */
  activeUsers: number
  activeWindowMinutes: number
  usage: UsageToday
  /** Rolling median duration of recent model calls **on `tier`** — the tier a
   *  new chat starts on, which is the one question this strip can still answer
   *  without knowing which conversation is open. Over the roles a tier decision actually
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
    // Read for the SEED tier, and after it is resolved: the strip has one slot
    // for this, and the one tier it can still name honestly is the one a new
    // chat starts on. Which tier the OPEN conversation is on is the switch's
    // question, and the strip does not know which conversation that is.
    latency: tierLatency(tier),
    generatedAt: Date.now(),
  }
}
