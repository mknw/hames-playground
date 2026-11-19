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
import { ensurePrivateTierAwake } from '../inference/wake.server'
import { largeOnOpenRouter } from '@hames-ai/harness-baml/inference-env.server'
import { largeEurPerHour, smallLlmEurPerHour } from '../cost-rates.server'

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

/** Everything the admin panel renders, in one payload — the switch and its
 *  provenance, plus the per-hour prices the app already computes
 *  (`cost-rates.server.ts`, the same figures every time-priced cost renders
 *  from). The boxes' live warm/cold/starting state is deliberately NOT in
 *  here: the panel reads it from `getPreviewHeaderState()`, the same source
 *  the header strip renders, so the two surfaces cannot disagree about the
 *  one box. */
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
  const state = await getGpuState()
  return {
    keepRunning: state.keepRunning,
    switchedOnAt: state.switchedOnAt,
    configured: selfDeployedConfigured(),
    largeEurPerHour: largeEurPerHour(),
    smallEurPerHour: smallLlmEurPerHour(),
    largeOnOpenRouter: largeOnOpenRouter(),
  }
}

/**
 * Flip the switch. `on` wakes both boxes NOW and waits for them (see the
 * module docstring); `off` is a plain write, and the boxes then scale down
 * after their own windows.
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
  // The switch is written BEFORE the wake: "on" is a promise the loop keeps
  // retrying, not a result the wake must succeed at first try. If the wake
  // fails, the owner sees the failure and the switch stays on — no silent
  // auto-off.
  await setGpuState(on)
  if (on) await ensurePrivateTierAwake()
  return getGpuAdminState()
}
