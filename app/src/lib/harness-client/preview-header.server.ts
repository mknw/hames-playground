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
import {
  probeVerdaReplicas,
  type VerdaControlPlaneProbe,
} from '../inference/verda-control-plane.server'
import { coldStartEstimate } from '../inference/cold-start.server'
import { ensureVerdaAwake } from '../inference/wake.server'
import { ACTIVE_WINDOW_MINUTES, countActiveUsers } from '../db/conversations.server'
import { getUsageToday, type UsageToday } from '../metrics/preview-counters.server'
import { tierLatency, type TierLatency } from '../metrics/call-latency.server'

async function requireUser(): Promise<{ id: string }> {
  if (isBypassEnabled()) return { id: BYPASS_USER.id }
  const u = await getAuthenticatedUser()
  return { id: u.id }
}

/**
 * The warmth the strip DISPLAYS, after both of its sources have had their say.
 *
 * Two sources, deliberately not merged into one module's opinion: the
 * process-local completion clock (`verdaWarmth`) is the only thing allowed to
 * say `ready` — a real completion answered by the deployment, zero-second
 * accurate, never a timer — and the control-plane probe
 * (`inference/verda-control-plane.server.ts`) is the shared observation that
 * replaces the old pre-message `unknown` with a real answer about the box.
 *
 * - `answering` — a turn is on the box AND the completion clock proves it was
 *   already warm. The turn-in-flight flavour of `ready`.
 * - `ready` — a completion was answered within the scale-down window.
 * - `starting` — the box is engaged but nothing proves the model is loaded: a
 *   turn is running without completion evidence, or the control plane reports
 *   a replica whose insides are still loading weights (measured ~360s).
 * - `cold` — the control plane reports NO replicas: observed scaled-down, not
 *   guessed. This is what retires the old failure where a warm box looked
 *   forever `unknown` to a process that had never seen a call.
 * - `unknown` — the DEGRADED display, and an error path: the probe is
 *   unconfigured, or it failed. Unreachable on every happy path. The ignite
 *   button stays available here (`igniteVerdaBox` is independent of the probe).
 */
export type WarmthDisplayState = 'answering' | 'starting' | 'ready' | 'cold' | 'unknown'

/** The `warmth` field of the payload — the display state plus whatever the
 *  countdown for it needs. One object rather than two parallel fields, so the
 *  number and the word it belongs to cannot be recombined wrongly. */
export interface HeaderWarmth {
  state: WarmthDisplayState
  /** `ready`/`answering`: whole seconds left of the scale-down window. The
   *  client ticks the `ready` one locally; `answering`'s is re-sent whole each
   *  poll (a box cannot scale down under a turn) and rendered statically. */
  secondsUntilScaledown: number | null
  scaledownSeconds: number
  /** `starting` only: the estimated time to first token STILL REMAINING, from
   *  `coldStartEstimate()` minus the oldest replica's age — the same estimate
   *  the chat's warming notice uses, spent by what the control plane has
   *  actually observed. `null` once the estimate is spent (the word stays; the
   *  figure does not sit at 0:00) or for every other state. An estimate with a
   *  basis on the wire, never a measurement dressed as one. */
  coldStartEstimateMs: number | null
  coldStartBasis: 'measured' | 'default' | null
  /** How many cold starts the median is over; `0` on the fallback. */
  coldStartSamples: number | null
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
  warmth: HeaderWarmth
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

/**
 * Map the two warmth sources onto the display state.
 *
 * The order IS the state machine, and each line is one of the settled rules:
 * completion evidence outranks everything (`ready` flips only on it, never on a
 * timer or a probe); a turn without that evidence is `starting`, whatever the
 * probe saw (the turn itself is the engagement, and degrading an ACTIVE turn to
 * `unknown` because a status API blinked would hide information the old strip
 * already had); and only the no-turn, no-evidence cases ask the control plane,
 * where an unavailable probe — the one error path — is `unknown`.
 */
function displayWarmth(w: VerdaWarmth, probe: VerdaControlPlaneProbe | null): HeaderWarmth {
  let state: WarmthDisplayState
  if (w.state === 'running') state = 'answering'
  else if (w.state === 'warm') state = 'ready'
  else if (w.state === 'starting') state = 'starting'
  else if (!probe || !probe.ok) state = 'unknown'
  else state = (probe.replicaCount ?? 0) > 0 ? 'starting' : 'cold'

  // The estimate is read only for the state that shows it. `coldStartEstimate()`
  // is cheap (a median over a handful of samples), but a field that is always
  // populated invites a consumer to render it for a state that must not claim
  // one — the same reason `secondsUntilScaledown` is null for the states below.
  //
  // What is sent is the REMAINING estimate, not the whole one: the oldest
  // replica's `started_at` is how long the container has actually been coming
  // up, and a figure re-sent whole on every 3s poll would snap back instead of
  // falling — the exact defect the strip's `answering` state litigated. The
  // client renders it statically; each poll re-sends a genuinely smaller
  // number. Past the estimate it sends null rather than a figure pinned at
  // zero — running long is expected (a burst queues on one replica), and "0:00"
  // would read as done for a box that is merely slow. When the base is unknown
  // (no parseable `started_at`, or the probe is down and a TURN made this
  // `starting`), the whole estimate goes out — pessimistic, and static.
  const estimate = state === 'starting' ? coldStartEstimate() : null
  let estimateMs: number | null = null
  if (estimate) {
    const startedAt = probe?.ok ? probe.oldestReplicaStartedAtMs : null
    const elapsedMs = startedAt !== null ? Math.max(0, Date.now() - startedAt) : 0
    const remainingMs = estimate.estimateMs - elapsedMs
    estimateMs = remainingMs > 0 ? remainingMs : null
  }
  return {
    state,
    secondsUntilScaledown: w.secondsUntilScaledown,
    scaledownSeconds: w.scaledownSeconds,
    coldStartEstimateMs: estimateMs,
    coldStartBasis: estimate?.basis ?? null,
    coldStartSamples: estimate?.samples ?? null,
  }
}

/** The strip's whole payload. Cheap by construction: two indexed reads and two
 *  process-local readings (the warm clock and the latency window) — no event
 *  blob is opened, which is what makes it safe to poll. "Indexed" is
 *  load-bearing for the active-user read and was not true when this shipped: it
 *  needs `conversations_updated_idx` (`db/client.server.ts`), the only index on
 *  that table that leads on `updated_at`.
 *
 * The control-plane probe rides the same `Promise.all` and is cached
 * process-side for 12s, so a settled poll pays it at most once per interval —
 * and when it cannot be answered, it degrades to `unknown` inside its own
 * 5s-per-fetch bound instead of hanging a poll that is supposed to be safe
 * beside a live chat. Skipped entirely when there is no endpoint: the whole
 * indicator is hidden for that deployment, so a probe would be noise. */
export async function getPreviewHeaderState(): Promise<PreviewHeaderState> {
  const user = await requireUser()
  const [stored, activeUsers, usage, probe] = await Promise.all([
    getStoredInferenceTier(user.id),
    countActiveUsers(),
    getUsageToday(),
    verdaConfigured() ? probeVerdaReplicas() : Promise.resolve(null),
  ])
  const tier = stored ?? defaultInferenceTier()
  return {
    tier,
    verdaAvailable: verdaConfigured(),
    warmth: displayWarmth(verdaWarmth(), probe),
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

/**
 * Start the self-hosted box from the header, and return the state the strip
 * should now show.
 *
 * The header's cold indicator is the only place a person can act on the box's
 * state rather than wait for it, and this is the whole of that action. It
 * reuses `ensureVerdaAwake` rather than issuing a wake of its own, which is not
 * a tidiness point — three properties a second wake path would each have to
 * re-earn come from being the SAME call the turn runner makes:
 *
 *  - **A click during an in-flight wake JOINS it.** The dedupe is one promise on
 *    a `globalThis` symbol inside that module, so a user who clicks and then
 *    sends a message, or two users on the same box, share one request instead of
 *    queueing two cold starts on a single replica.
 *  - **A click on a warm box is free.** `ensureVerdaAwake` returns on
 *    `verdaProvenWarm` without touching the network, so the button cannot bill
 *    GPU seconds for a box that is already up.
 *  - **The measurement stays honest.** Only the caller that STARTED the ping
 *    records its duration, and the plausibility floor still applies, so a click
 *    cannot enter a four-second no-op into the cold-start history the chat's
 *    countdown is estimated from.
 *
 * It waits for the box rather than returning immediately, so the caller learns
 * whether it actually came up. That can legitimately take minutes
 * (`VERDA_WAKE_TIMEOUT_MS`); a failure REJECTS, carrying the message that names
 * the box, because a wake that silently did nothing is the one outcome that
 * leaves a user believing their next message will be quick when it will not.
 */
export async function igniteVerdaBox(): Promise<PreviewHeaderState> {
  await requireUser()
  // Same refusal as the tier switch, for the same reason: without an endpoint
  // there is nothing to start, and `ensureVerdaAwake` would otherwise fail on a
  // `fetch` to an empty URL — an error about a malformed request rather than
  // about an unconfigured deployment.
  if (!verdaConfigured()) {
    throw new Error(
      'The self-hosted inference endpoint is not configured on this deployment, so there is ' +
        'nothing to start. Set VERDA_INFERENCE_ENDPOINT and VERDA_INFERENCE_API_KEY (see ' +
        'app/.env.example).',
    )
  }
  await ensureVerdaAwake()
  return getPreviewHeaderState()
}
