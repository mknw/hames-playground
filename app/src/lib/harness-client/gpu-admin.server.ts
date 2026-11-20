/**
 * The GPU admin panel's server actions (#1047) — the owner-only surface that
 * connects the self-deployed boxes on demand and keeps them running until
 * switched off.
 *
 * ## The gate
 *
 * Every export of a `'use server'` module is an RPC the browser can call, so
 * each one decides admin-ness itself — the tab being hidden is presentation,
 * not access control (owner, 2026-11-19: the panel "will be only accessible
 * to me"). A non-admin is refused by a THROWN `Response` with status 403:
 * thrown responses are the framework's own status channel (they pass through
 * `toWireError` untouched, and the wire answer carries the 403), so the
 * refusal is a real HTTP status rather than a payload the caller could
 * mistake for an answer. `isAdminUser` is the one deliberate non-throwing
 * export: the nav tab needs a boolean, and a signed-out visitor is simply not
 * an admin.
 *
 * The allow-list is `ADMIN_EMAILS` (`auth/admin.ts`) — the app had no admin
 * or role concept, and inventing one for Entra was out of scope for a demo
 * deadline. Unset means nobody is an admin and the panel does not exist.
 *
 * `requireUser` is duplicated rather than imported from
 * `preview-header.server.ts` for the same reason that module duplicates it
 * from `actions.server.ts`: a `'use server'` file cannot export a shared
 * helper without also exporting it as an RPC.
 *
 * ## The switch, and why switching on WAKES and WAITS
 *
 * `setGpuKeepRunning(true)` writes the persistent switch first, then calls
 * `ensurePrivateTierAwake()` — the turn's own wake, not a second one — and
 * waits for the box like the header button does. A cold start can take
 * minutes; the caller learns whether it came up. If it does NOT, the
 * rejection carries the failure AND THE SWITCH STAYS ON: there is no silent
 * auto-off (the owner's explicit call — the panel is for a demo, and a switch
 * that quietly reverted while the owner's back was turned would guarantee the
 * one outcome it exists to prevent). The process-side loop
 * (`inference/gpu-keep-running.server.ts`) retries every tick until the boxes
 * answer or the owner switches it off.
 *
 * Switching OFF is a plain write: the loop stops touching the boxes within
 * one tick, and they scale down after their own configured windows — exactly
 * today's behaviour with nobody keeping them warm.
 */
'use server'

import { getAuthenticatedUser } from '../auth/server'
import { BYPASS_USER, isBypassEnabled } from '../auth/dev-bypass'
import { isAdminEmail } from '../auth/admin'
import { getGpuState, setGpuState } from '../db/gpu-state.server'
import { selfDeployedConfigured } from '../inference/config.server'
import { largeUpSince } from '../inference/large-activity.server'
import {
  coldStartEstimate,
  smallColdStartEstimate,
  smallProvenWarm,
  smallUpSince,
} from '../inference/cold-start.server'
import { ensurePrivateTierAwake, smallWakeInFlight } from '../inference/wake.server'
import { largeOnOpenRouter } from '@hames-ai/harness-baml/inference-env.server'
import { largeEurPerHour, smallLlmEurPerHour } from '../cost-rates.server'
import { driveModalSwitch, pendingReleaseBoxes } from '../inference/gpu-keep-running.server'
import {
  modalBoxProbe,
  modalControlConfigured,
  probeModalBoxes,
  stopModalBoxContainers,
  type ModalBox,
} from '../inference/modal-control.server'
import { readBoxStatus } from '../inference/box-status.server'
import { readBoxPhase } from '../inference/box-phase.server'

async function requireUser(): Promise<{ id: string; email: string }> {
  if (isBypassEnabled()) return { id: BYPASS_USER.id, email: BYPASS_USER.email }
  const u = await getAuthenticatedUser()
  return { id: u.id, email: u.email }
}

/** The 403 a non-admin gets from every state-changing or state-reading export
 *  below. A `Response` rather than an `Error` so the refusal is the framework's
 *  own status channel — the wire carries 403, and the in-process caller
 *  (a test, server rendering) is handed a real Response to assert on.
 *
 *  The wording names nothing: no capability, no configuration, no hint of how
 *  access is granted. A refusal that explains itself teaches whoever it just
 *  refused what to go looking for. */
function forbidden(): Response {
  return new Response('You do not have access to this page.', { status: 403 })
}

/** The admin gate. Resolves the caller from the session the same way
 *  `preview-header.server.ts` does — never from a parameter, which would let
 *  the caller choose whose admin-ness is being checked. A caller with no
 *  session is refused with the SAME 403 rather than the auth error: to this
 *  panel there is one answer for everyone who is not the admin, and the page
 *  renders one forbidden state for it instead of distinguishing two failures
 *  nobody asked it to distinguish. */
async function requireAdmin(): Promise<{ id: string; email: string }> {
  let user: { id: string; email: string }
  try {
    user = await requireUser()
  } catch {
    throw forbidden()
  }
  if (!isAdminEmail(user.email)) throw forbidden()
  return user
}

// ============================================================================
// The Modal control plane's word on each box (#1057)
// ============================================================================

/**
 * One box's state as the panel renders it, composed from Modal's control
 * plane plus the box's own `GET /status` — the two sources the admin panel
 * did not have before this: the state words were INFERRED from this process's
 * clocks (a wake in flight, each box's last answer), and "restored vs full
 * boot" was nowhere at all.
 *
 * The states:
 *  - `up` — Modal lists a container REGISTERED TO SERVE (its boot is done) and
 *    that container's `/status`, read ONCE, answered or not: when it did, the
 *    box's own readiness file, so `restored` (snapshot vs full boot) and `gpu`
 *    are the box's own words, not an inference from age.
 *  - `booting` — Modal has CREATED a container (queued or booting: Modal's task
 *    list, with its start time) that is not serving yet, so the weights load
 *    inside it. This is the state of the whole 8–15 minute full boot.
 *  - `cold` — zero containers, no boot pending: observed scaled-to-zero.
 *  - `not-starting` — zero containers while a boot has been pending longer
 *    than `modalNotStartingAfterMs()` — Modal never created one: the
 *    2026-11-19 failure, named as one instead of sitting out the whole 1200 s
 *    timeout (the morning's 237 unanswered attempts over 1200 s).
 *  - `unknown` — the control-plane read failed; the panel says so and falls
 *    back to the inferred display beside it.
 */
export type GpuBoxLineState = 'up' | 'booting' | 'cold' | 'not-starting' | 'unknown'

/** One box's admin line — everything the panel's per-box sentence renders. */
export interface GpuBoxLine {
  state: GpuBoxLineState
  /** Containers Modal reports; `null` when the read failed. */
  containers: number | null
  /** The oldest container's start per the control plane, epoch ms, when it
   *  reports one — the honest "up since" for the panel's line and the cost
   *  meter's seed. `null` when unknown. */
  containerStartedAtMs: number | null
  /** `/status` `restored`, read only once a container is up: `true` a
   *  snapshot restore, `false` a full boot; `null` when unread. */
  restored: boolean | null
  /** `/status` `gpu` (the small box reports `nvidia-smi`'s name; the 27B's
   *  status file carries none), `null` when unread or absent. */
  gpu: string | null
  /** While `booting`: this box's snapshot-restore estimate in ms (the median
   *  of cold starts this process measured, else the slowest measured
   *  restore) — the figure the panel sets the elapsed time against, beside the
   *  full-boot range, so a full boot is not mistaken for a failure. */
  restoreEstimateMs: number | null
  /** When `state` is not healthy: why, in the panel's own words. */
  reason: string | null
}

/** Both boxes, or `null` while Modal control is unavailable — the payload the
 *  panel's per-box lines render, and the marker its fallback label reads. */
export interface ModalAdminState {
  /** The 27B's line, or `null` on the OpenRouter route (`LARGE_LLM_ROUTE=
   *  openrouter`): a public per-token API is not a scale-to-zero box of ours
   *  to keep, boot or stop, and the panel already says so in the rate
   *  breakdown — this line must not invent a second box to control. */
  large: GpuBoxLine | null
  small: GpuBoxLine
}

/** Compose one box's line. Never throws: every failure is a degraded line the
 *  panel renders as `unknown` — a broken control plane costs a line, not the
 *  payload. The phase itself is `inference/box-phase.server.ts`'s one
 *  derivation (the chat's warming notice reads the same). */
async function modalBoxLine(box: ModalBox, now: number): Promise<GpuBoxLine | null> {
  if (box === 'large' && largeOnOpenRouter()) return null
  const reading = readBoxPhase(box, modalBoxProbe(await probeModalBoxes(), box), now)
  const none = { restored: null, gpu: null, restoreEstimateMs: null }
  switch (reading.phase) {
    case 'unknown':
      return {
        ...none,
        state: 'unknown',
        containers: null,
        containerStartedAtMs: null,
        reason: reading.reason,
      }
    case 'cold':
      return { ...none, state: 'cold', containers: 0, containerStartedAtMs: null, reason: null }
    case 'waiting':
      // A boot has been ASKED for (the wake poll, the switch's ON, the loop) and
      // Modal has not created a container yet.
      return {
        ...none,
        state: 'booting',
        containers: 0,
        containerStartedAtMs: reading.startedAtMs,
        restoreEstimateMs: restoreEstimateMs(box),
        reason: null,
      }
    case 'not-starting':
      return {
        ...none,
        state: 'not-starting',
        containers: 0,
        containerStartedAtMs: reading.startedAtMs,
        reason: `Modal reports no container after ${Math.round(reading.waitedMs / 1000)}s of asking`,
      }
    case 'booting':
      // A container exists and is not serving: its boot runs inside it, for the
      // whole 8-15 minutes of a full boot.
      return {
        ...none,
        state: 'booting',
        containers: reading.containers,
        containerStartedAtMs: reading.startedAtMs,
        restoreEstimateMs: restoreEstimateMs(box),
        reason: reading.readinessUnknown
          ? 'Modal did not say whether the container is serving yet'
          : null,
      }
    case 'up': {
      // `/status` is read for a READY container only — the one request this path
      // may send a box, once per container id (`box-status.server.ts`) — because
      // asking a box that is not serving would be asking it to wake.
      const status = await readBoxStatus(box, reading.ready!.id)
      return {
        state: 'up',
        containers: reading.containers,
        containerStartedAtMs: reading.startedAtMs,
        restored: status?.restored ?? null,
        gpu: status?.gpu ?? null,
        restoreEstimateMs: null,
        reason: null,
      }
    }
  }
}

/** The box's snapshot-restore figure: its measured median, else the fallback. */
function restoreEstimateMs(box: ModalBox): number {
  return (box === 'large' ? coldStartEstimate() : smallColdStartEstimate()).estimateMs
}

/** The boxes the switch drives through Modal — the 27B only when it is one of
 *  ours (not on the OpenRouter route), matching the wake's own skip. */
function modalBoxes(): ModalBox[] {
  return largeOnOpenRouter() ? ['small'] : ['large', 'small']
}

/** One line's thrown error, in the panel's own words. */
function controlFailure(box: ModalBox, doing: string, reason: string | null): Error {
  return new Error(
    `Modal control could not ${doing} for the ${box === 'large' ? '27B' : '4B'} box` +
      `${reason ? ` (${reason})` : ''}.`,
  )
}

/** Everything the admin panel renders, in one payload — the switch and its
 *  provenance, plus the per-hour prices the app already computes
 *  (`cost-rates.server.ts`, the same figures every time-priced cost renders
 *  from), plus the per-box fields the cost meter meters with. The 27B's live
 *  warm/cold/starting state is deliberately NOT in here: the panel reads it
 *  from `getPreviewHeaderState()`, the same source the header strip renders,
 *  so the two surfaces cannot disagree about that box. The per-box fields
 *  below serve only this panel, so they ride this admin-only payload rather
 *  than the one every signed-in user receives (#1047 review round 4). */
export interface GpuAdminState {
  keepRunning: boolean
  /** When the switch was last turned ON, epoch ms; null while it is off —
   *  "running since" is a claim only an on switch can make. */
  switchedOnAt: number | null
  /** False when the deployment has no private tier configured; the switch is
   *  then rendered inert rather than refused, so the panel explains itself. */
  configured: boolean
  /** `LARGE_LLM_EUR_PER_HOUR`, the 27B box's hourly rate. */
  largeEurPerHour: number
  /** The small summarizer box's hourly rate (`SMALL_LLM_EUR_PER_HOUR`). */
  smallEurPerHour: number
  /** True when the 27B rides the OpenRouter route (`LARGE_LLM_ROUTE=openrouter`):
   *  a public per-token API is not a scale-to-zero box of ours, so the
   *  keep-running loop keeps no 27B box up (the wake skips it for the same
   *  reason, `wake.server.ts`) — and the panel's per-hour figure must skip
   *  its rate for exactly as long, or it prices a box nobody is keeping. */
  largeOnOpenRouter: boolean
  /** When this process first observed the 27B UP in its current up-period,
   *  epoch ms, or `null` — before it has seen an answer, after a restart
   *  (the clock is process-local), and once the scale-down window has passed
   *  the last answer (`large-activity.server.ts`, `largeUpSince`). The meter
   *  seeds the 27B's accrual from `max(this, switchedOnAt)` after a reload,
   *  so it re-bills the time the box was actually up through this switch-on
   *  and neither re-adds the cold start before it first came up nor restarts
   *  at ~zero because a keep-warm ping refreshed the completion clock. */
  largeUpSince: number | null
  /** The 4B summarizer box's live state, from its own per-box clocks
   *  (`cold-start.server.ts`): `ready` when an answer inside its idle window
   *  proves it up, `starting` while one of the shared small-box wake polls
   *  is on the wire for it, `cold` otherwise. The same evidence class as the
   *  27B's `ready`/`answering` — a real answer, never a timer — and
   *  `starting` does NOT count as up: the cold start it may end in is not
   *  billed time. */
  smallState: 'ready' | 'starting' | 'cold'
  /** The 4B's own `upSince` (`cold-start.server.ts`), seeding the small
   *  half of the meter exactly as `largeUpSince` seeds the 27B's. */
  smallUpSince: number | null
  /** Modal's word on each box (#1057), or `null` while Modal control is
   *  unavailable (`MODAL_CONTROL_BASE` / `MODAL_CONTROL_TOKEN` unset): the
   *  panel then says "Modal control unavailable (no token)", the switch drives
   *  the boxes through keep-warm pings — today's behaviour, labelled as the
   *  fallback — and every other field falls back to its own inference. */
  modal: ModalAdminState | null
  /** Boxes whose release (`min_containers=0`) Modal has not confirmed — the
   *  switch reads OFF but Modal may still hold `1` there. The panel refuses
   *  "stop now" for them and says why: Modal would start a replacement. */
  releasePending: ('large' | 'small')[]
}

/** Is THIS caller an admin? Never throws: a signed-out visitor is simply not
 *  one, and the nav tab this answers must not pay for a rejected poll on
 *  every page load. */
export async function isAdminUser(): Promise<boolean> {
  try {
    const user = await requireUser()
    return isAdminEmail(user.email)
  } catch {
    return false
  }
}

/** Read the panel's payload. Admin-gated like the switch: the state itself is
 *  not secret, but the surface is the owner's, and a panel a non-admin can
 *  read is a panel a non-admin can be tricked into acting on. */
export async function getGpuAdminState(): Promise<GpuAdminState> {
  await requireAdmin()
  const now = Date.now()
  const state = await getGpuState()
  // Both lines compose from ONE control-plane probe (cached 12 s process-side)
  // and at most one `/status` per box with a container up. `null` while the
  // control route is unconfigured — the payload the fallback label reads.
  let modal: ModalAdminState | null = null
  if (modalControlConfigured()) {
    modal = {
      large: await modalBoxLine('large', now),
      small: (await modalBoxLine('small', now)) as GpuBoxLine,
    }
  }
  return {
    keepRunning: state.keepRunning,
    switchedOnAt: state.switchedOnAt,
    configured: selfDeployedConfigured(),
    largeEurPerHour: largeEurPerHour(),
    smallEurPerHour: smallLlmEurPerHour(),
    largeOnOpenRouter: largeOnOpenRouter(),
    largeUpSince: largeUpSince(),
    smallState: smallProvenWarm() ? 'ready' : smallWakeInFlight() ? 'starting' : 'cold',
    smallUpSince: smallUpSince(),
    modal,
    releasePending: pendingReleaseBoxes(),
  }
}

/**
 * Flip the switch (#1047, and #1057's control route).
 *
 * **With Modal control available** the switch drives Modal's autoscaler: `on`
 * asserts `min_containers=1` per box — which BOOTS both boxes with no request
 * sent to either, the acceptance #1057 asks for — and `off` asserts `0`, which
 * returns each box to scale-to-zero after its own configured window. The
 * action does NOT wait for a boot: `min_containers=1` is an instruction, not
 * a poll, and a full boot can take 8–15 minutes (the panel's per-box lines show
 * it). The process-side loop (`inference/gpu-keep-running.server.ts`)
 * re-asserts `1` every tick while the switch is on, so a redeploy — which
 * resets the override to the app's own static value — cannot silently scale
 * the demo box down. `off` is CONFIRMED: Modal must report `min_containers=0`,
 * or the release is left pending and the loop retries it with a bounded
 * backoff (a failed release rejects, naming it; the switch reads OFF either
 * way). The flip, and every loop tick, run under one lock, so a tick can never
 * re-assert `1` after an OFF.
 *
 * **Without it** (`MODAL_CONTROL_BASE`/`MODAL_CONTROL_TOKEN` unset) this is
 * exactly the #1047 behaviour: `on` wakes both boxes through the one shared
 * wake and WAITS (a cold start can take minutes; the caller learns whether they
 * came up), the loop keeps them warm with pings, and `off` is a plain write
 * after which the boxes scale down after their own windows. The panel labels
 * this as the fallback.
 *
 * Either way the switch is written BEFORE the boxes are touched: "on" is a
 * promise the loop keeps, not a result the first call must succeed at. A
 * failed boot/autoscaler call rejects — carrying the reason — and the switch
 * STAYS ON (no silent auto-off, the owner's explicit call): the owner sees the
 * failure, and the loop retries.
 *
 * Refuses — without writing anything — when the private tier is not
 * configured, for the same reason `igniteSelfDeployedBox` does: there is
 * nothing to keep running, and a switch that stored ON for an unreachable
 * deployment would spin the loop against a wall.
 *
 * The one argument is validated at the RPC boundary: the wire can carry
 * anything as `on`, and the switch is written from it, so only a real
 * boolean is accepted — anything else is refused with a 400 before a session
 * is resolved and before anything is written.
 */
export async function setGpuKeepRunning(on: boolean): Promise<GpuAdminState> {
  if (typeof on !== 'boolean') {
    throw new Response('The switch state must be a boolean (on or off).', { status: 400 })
  }
  await requireAdmin()
  if (on && !selfDeployedConfigured()) {
    throw new Error(
      'The self-hosted inference endpoint is not configured on this deployment, so there is ' +
        'nothing to keep running. Set LARGE_LLM_BASE_URL, LARGE_LLM_API_KEY and the SMALL_LLM_* ' +
        'variables (see app/.env.example).',
    )
  }
  if (!modalControlConfigured()) {
    // Today's behaviour, untouched: the wake-and-wait, the pings, the plain off.
    await setGpuState(on)
    if (on) await ensurePrivateTierAwake()
    return getGpuAdminState()
  }
  // The control route: write the switch and assert the autoscaler per box,
  // without a request to either — all of it under the lock the keep-running
  // loop's ticks share, so a tick that had read ON can never land its `1` after
  // this `0`. ON stamps the boot clock; OFF is CONFIRMED (Modal reporting
  // min_containers=0) or left for the loop to retry. A box the deployment does
  // not keep (the 27B on the OpenRouter route) is skipped exactly as the wake
  // skips it.
  const failure = await driveModalSwitch(on, modalBoxes())
  if (failure) {
    throw failure.doing === 'boot'
      ? controlFailure(failure.box, 'set min_containers to 1', failure.reason)
      : new Error(
          `Modal did not confirm the release (min_containers 0) for the ${
            failure.box === 'large' ? '27B' : '4B'
          } box${failure.reason ? ` (${failure.reason})` : ''}. The switch is OFF and the ` +
            `server keeps retrying until Modal confirms it.`,
        )
  }
  return getGpuAdminState()
}

/**
 * Stop a box's containers NOW (#1057) — `ops.py stop`'s call through the
 * control sidecar, one container at a time — instead of waiting out the
 * billed scaledown window. The panel calls it for a box that is stuck
 * (billing for a boot that is not going anywhere) from a per-line button
 * behind a confirmation, and it is admin-gated like every other control
 * here. A turn in flight against the stopped box fails exactly as a scaled
 * box does — visibly, with the message naming the box.
 *
 * **Refused while a release is unconfirmed** (the switch reads OFF but Modal has
 * not reported `min_containers=0` for the box, `pendingReleaseBoxes()`): Modal may
 * still hold `1` there, so the same replacement follows. The panel says so.
 *
 * **Refused while the switch is ON**: with `min_containers=1` Modal starts a
 * replacement the moment a container stops, so a stop would be a billed restart
 * rather than a stop. Release the switch first (the panel says so beside the
 * disabled button).
 *
 * The one argument is validated at the RPC boundary: the wire can carry
 * anything as `box`, so only one of the two real boxes is accepted.
 */
export async function stopGpuBoxNow(box: 'large' | 'small'): Promise<GpuAdminState> {
  if (box !== 'large' && box !== 'small') {
    throw new Response('The box must be "large" (the 27B) or "small" (the 4B).', { status: 400 })
  }
  await requireAdmin()
  if (!modalControlConfigured()) {
    throw new Error(
      'Modal control is unavailable (no token), so there is nothing to stop from here. ' +
        'Set MODAL_CONTROL_BASE and MODAL_CONTROL_TOKEN (see app/.env.example), or run ' +
        '`ops.py stop` from deploy/modal.',
    )
  }
  if (box === 'large' && largeOnOpenRouter()) {
    throw new Error(
      'The 27B runs through OpenRouter (LARGE_LLM_ROUTE=openrouter): it is not a Modal box ' +
        'of ours, so there is nothing here to stop.',
    )
  }
  if ((await getGpuState()).keepRunning) {
    throw new Error(
      'The keep-running switch is ON, so Modal would start a replacement container at once ' +
        '(min_containers=1): stopping now would be a billed restart, not a stop. Switch it off ' +
        'first, then stop the box.',
    )
  }
  if (pendingReleaseBoxes().includes(box)) {
    throw new Error(
      `Modal has not confirmed the release (min_containers 0) for the ${
        box === 'large' ? '27B' : '4B'
      } box yet, so it may still hold one container up and would start a replacement at once: ` +
        'stopping now would be a billed restart, not a stop. The server keeps retrying the ' +
        'release; stop the box once it is confirmed.',
    )
  }
  const answer = await stopModalBoxContainers(box)
  if (!answer.ok) throw controlFailure(box, 'stop its containers', answer.reason)
  return getGpuAdminState()
}
