/**
 * The boot splash's arithmetic and its cross-mount clock.
 *
 * These are the claims the component itself cannot make cheaply, and one of
 * them — "the fill never reaches 100 %" — is a REQUIREMENT rather than an
 * implementation detail: the wait's real length is unknowable from inside the
 * splash, so a full bar in front of a screen that has not changed is a promise
 * being broken. It is pinned here across the whole domain rather than sampled,
 * because the exponential is exactly the kind of expression someone later
 * "simplifies" into a linear ramp with a clamp.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  SPLASH_CONTINUITY_GAP_MS,
  SPLASH_FILL_CEILING,
  SPLASH_FILL_FLOOR,
  SPLASH_LINES,
  SPLASH_LINE_MS,
  resetSplashClock,
  splashElapsedMs,
  splashLine,
  splashMounted,
  splashPercent,
  splashUnmounted,
} from '~/lib/splash-progress'

beforeEach(resetSplashClock)

describe('splashPercent', () => {
  it('never reaches 100, at any elapsed time', () => {
    // Every 50 ms of the first two minutes, then the absurd end of the range —
    // a wait this long is a broken app, and the bar still must not claim done.
    for (let t = 0; t <= 120_000; t += 50) {
      expect(splashPercent(t)).toBeLessThan(100)
      expect(splashPercent(t)).toBeLessThanOrEqual(SPLASH_FILL_CEILING)
    }
    for (const t of [10 * 60_000, 60 * 60_000, Number.MAX_SAFE_INTEGER]) {
      expect(splashPercent(t)).toBeLessThan(100)
    }
  })

  it('starts at a visible sliver rather than at zero width', () => {
    // The server-rendered frame is at elapsed 0, and a zero-width fill is
    // indistinguishable from a broken bar.
    expect(splashPercent(0)).toBe(SPLASH_FILL_FLOOR)
    expect(splashPercent(-1000)).toBe(SPLASH_FILL_FLOOR)
  })

  it('never goes backwards', () => {
    let previous = -1
    for (let t = 0; t <= 30_000; t += 25) {
      const percent = splashPercent(t)
      expect(percent).toBeGreaterThanOrEqual(previous)
      previous = percent
    }
  })

  it('is visibly moving across the window it actually covers', () => {
    // The measured post-login wait is ~350 ms (warm) to ~4 s (the owner's
    // preview report). A bar that spent that range under 5 % or over 95 %
    // would be technically correct and useless.
    expect(splashPercent(350)).toBeGreaterThan(5)
    expect(splashPercent(1000)).toBeGreaterThan(20)
    expect(splashPercent(4000)).toBeGreaterThan(60)
    expect(splashPercent(4000)).toBeLessThan(SPLASH_FILL_CEILING)
  })
})

describe('splashLine', () => {
  it('walks the list in order, one line per interval', () => {
    SPLASH_LINES.forEach((line, index) => {
      expect(splashLine(index * SPLASH_LINE_MS)).toBe(line)
      expect(splashLine(index * SPLASH_LINE_MS + SPLASH_LINE_MS - 1)).toBe(line)
    })
  })

  it('clamps on the last line instead of cycling', () => {
    // A list that loops reads as a stall the second time round.
    const last = SPLASH_LINES[SPLASH_LINES.length - 1]
    expect(splashLine(SPLASH_LINES.length * SPLASH_LINE_MS)).toBe(last)
    expect(splashLine(10 * 60_000)).toBe(last)
  })

  it('starts on the first line, including before time has passed', () => {
    expect(splashLine(0)).toBe(SPLASH_LINES[0])
    expect(splashLine(-500)).toBe(SPLASH_LINES[0])
  })
})

describe('SPLASH_LINES', () => {
  it('holds six to ten distinct, non-empty lines', () => {
    expect(SPLASH_LINES.length).toBeGreaterThanOrEqual(6)
    expect(SPLASH_LINES.length).toBeLessThanOrEqual(10)
    expect(new Set(SPLASH_LINES).size).toBe(SPLASH_LINES.length)
    for (const line of SPLASH_LINES) expect(line.trim().length).toBeGreaterThan(0)
  })
})

describe('the cross-mount clock', () => {
  it('reads zero before any splash has mounted', () => {
    expect(splashElapsedMs(1_000)).toBe(0)
  })

  it('keeps one wait across a remount inside the continuity gap', () => {
    // This is the handover the fix depends on: `AuthProvider`'s `<Show>`
    // unmounts the splash and `app.tsx`'s `<Suspense>` mounts it in the same
    // tick. A per-mount clock would send the bar backwards mid-wait.
    splashMounted(1_000)
    expect(splashElapsedMs(1_400)).toBe(400)
    splashUnmounted(1_400)
    splashMounted(1_450)
    expect(splashElapsedMs(2_000)).toBe(1_000)
  })

  it('starts a new wait when the splash was gone for longer than the gap', () => {
    splashMounted(1_000)
    splashUnmounted(1_200)
    // A suspension much later is a different wait, not a continuation.
    splashMounted(1_200 + SPLASH_CONTINUITY_GAP_MS + 1)
    expect(splashElapsedMs(1_200 + SPLASH_CONTINUITY_GAP_MS + 1)).toBe(0)
  })

  it('treats a remount exactly on the gap boundary as the same wait', () => {
    splashMounted(5_000)
    splashUnmounted(5_100)
    splashMounted(5_100 + SPLASH_CONTINUITY_GAP_MS)
    expect(splashElapsedMs(5_100 + SPLASH_CONTINUITY_GAP_MS)).toBe(100 + SPLASH_CONTINUITY_GAP_MS)
  })

  it('does not restart a wait just because the clock was not read for a while', () => {
    // The regression this shape exists for: browsers throttle `setInterval` in
    // a background tab to roughly once a second, so a gap measured between
    // READS would restart the bar for anyone who tabbed away mid-load. The
    // splash never unmounted here, so it is still one wait.
    splashMounted(1_000)
    expect(splashElapsedMs(1_100)).toBe(100)
    expect(splashElapsedMs(1_100 + 10 * SPLASH_CONTINUITY_GAP_MS)).toBe(
      100 + 10 * SPLASH_CONTINUITY_GAP_MS,
    )
  })

  it('never reports a negative elapsed if the clock jumps backwards', () => {
    splashMounted(10_000)
    expect(splashElapsedMs(9_900)).toBeGreaterThanOrEqual(0)
  })

  it('only marks the wait idle once the last overlapping splash is gone', () => {
    splashMounted(1_000)
    splashMounted(1_010)
    splashUnmounted(1_020)
    // One is still up, so the long pause below is not an absence.
    splashMounted(1_020 + 5 * SPLASH_CONTINUITY_GAP_MS)
    expect(splashElapsedMs(1_020 + 5 * SPLASH_CONTINUITY_GAP_MS)).toBe(
      20 + 5 * SPLASH_CONTINUITY_GAP_MS,
    )
  })
})
