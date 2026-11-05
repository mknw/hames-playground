/**
 * Which time zone a turn's "now" is read in — Server Only.
 *
 * The ONE resolver, called once per turn by `runTurnAndPersist`, which puts the
 * result on the run frame's `clock` slot (`@hames-ai/harness-patterns/clock`).
 * Every prompt that reasons about time and every tool that means "today" reads
 * that slot, so the order below is the whole policy:
 *
 *   1. **The browser's zone**, sent with the turn (`timeZone` on the
 *      `/api/events` body, from `Intl.DateTimeFormat().resolvedOptions()`).
 *      Validated against the IANA set; anything else is REFUSED — dropped, not
 *      used and not stored — and the turn falls through to step 2. A valid one
 *      is also remembered (step 2's value) when it differs from what is stored.
 *   2. **The user's last known zone**, `user_prefs.time_zone`. What a triggered
 *      run or a routine gets, since neither has a browser: the owner's zone.
 *   3. **The deployment default**, `APP_DEFAULT_TIME_ZONE`.
 *   4. **UTC**, marked `zoneUnknown`, so the time block tells the model the zone
 *      is a guess and the answer can say so.
 *
 * Fail-open on the TURN, fail-closed on the VALUE: a junk zone, an unreadable
 * preference row or a failed write never refuses a turn (the zone is a
 * convenience, the turn is the user's work), but no unvalidated string ever
 * reaches the clock — every step's value goes through `validTimeZone`.
 *
 * Deliberately NOT a `'use server'` module: it takes a `userId` (SD-13).
 */
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import { validTimeZone, type TurnClock } from '@hames-ai/harness-patterns/clock'
import { getStoredTimeZone, setStoredTimeZone } from './db/user-prefs.server'

assertServerOnImport()

export type TimeZoneSource = 'browser' | 'stored' | 'deployment' | 'utc-fallback'

let warnedInvalidDefault = false

/**
 * `APP_DEFAULT_TIME_ZONE`, validated, or `null` when unset. A value that is set
 * but is not an IANA zone is `null` too, with one warning per process: a typo
 * in a deployment's env must not become every user's clock.
 */
export function deploymentTimeZone(): string | null {
  const raw = process.env.APP_DEFAULT_TIME_ZONE?.trim()
  if (!raw) return null
  const zone = validTimeZone(raw)
  if (!zone && !warnedInvalidDefault) {
    warnedInvalidDefault = true
    console.warn(
      '[time-zone] APP_DEFAULT_TIME_ZONE is not an IANA time zone; turns without a known zone use UTC.',
    )
  }
  return zone
}

/**
 * The clock for one turn, and which step of the order supplied its zone.
 * `instant` is the turn's start, captured by the caller once.
 */
export async function resolveTurnClock(input: {
  userId: string
  browserTimeZone?: unknown
  instant: number
}): Promise<{ clock: TurnClock; source: TimeZoneSource }> {
  const { userId, instant } = input
  const claimed = input.browserTimeZone
  const browser = validTimeZone(claimed)
  if (claimed !== undefined && claimed !== null && !browser) {
    // Never the value itself: it is request data of any length and content.
    console.warn('[time-zone] refused a browser time zone that is not an IANA zone name')
  }

  const stored = await getStoredTimeZone(userId).catch((err: unknown) => {
    console.error('[time-zone] could not read the stored time zone:', err)
    return null
  })

  if (browser) {
    if (browser !== stored) {
      await setStoredTimeZone(userId, browser).catch((err: unknown) =>
        console.error('[time-zone] could not store the browser time zone:', err),
      )
    }
    return { clock: { instant, timeZone: browser }, source: 'browser' }
  }
  if (stored) return { clock: { instant, timeZone: stored }, source: 'stored' }
  const deployment = deploymentTimeZone()
  if (deployment) return { clock: { instant, timeZone: deployment }, source: 'deployment' }
  return { clock: { instant, timeZone: 'UTC', zoneUnknown: true }, source: 'utc-fallback' }
}
