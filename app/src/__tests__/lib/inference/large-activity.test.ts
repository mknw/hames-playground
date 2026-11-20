/**
 * Large-box warm-state — the countdown the header renders, and the two ways it
 * could lie.
 *
 * The failures pinned here are the ones a reader cannot spot: a countdown that
 * keeps ticking while a turn is actually running (scale-down cannot happen
 * then), "cold" presented where the truthful answer is "this process has never
 * seen a call", and an unbalanced in-flight gauge pinning the indicator to
 * "answering" forever after a turn throws.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

import {
  DEFAULT_LARGE_LLM_SCALEDOWN_SECONDS,
  beginSelfDeployedTurn,
  endSelfDeployedTurn,
  noteLargeCallCompleted,
  resetLargeActivity,
  largeScaledownSeconds,
  largeUpSince,
  largeWarmth,
} from '../../../lib/inference/large-activity.server'

const NOW = 1_700_000_000_000

beforeEach(() => {
  resetLargeActivity()
  delete process.env.LARGE_LLM_SCALEDOWN_SECONDS
})

afterEach(() => {
  resetLargeActivity()
  delete process.env.LARGE_LLM_SCALEDOWN_SECONDS
})

describe('largeScaledownSeconds', () => {
  it('defaults to the deployment’s current 300s', () => {
    // Owner-confirmed 2026-08-26. Pinned as a literal, not just as "whatever
    // the constant says": the countdown is a claim about a deployment the app
    // cannot interrogate, so the number is the assertion. `app/.env.example`
    // carries the same value uncommented and the two must not drift.
    expect(largeScaledownSeconds()).toBe(DEFAULT_LARGE_LLM_SCALEDOWN_SECONDS)
    expect(DEFAULT_LARGE_LLM_SCALEDOWN_SECONDS).toBe(300)
  })

  it('takes the env value, so production can raise it without a rebuild', () => {
    process.env.LARGE_LLM_SCALEDOWN_SECONDS = '900'
    expect(largeScaledownSeconds()).toBe(900)
  })

  it('falls back rather than rendering "scaling down now, forever"', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // '0.5' is the #308 case: positive as parsed, `0` once floored.
    // A silent fallback would hide a misconfigured deployment behind a
    // plausible countdown, so EACH bad value must warn, not merely the run:
    // a silent `seconds > 0 ? seconds : DEFAULT` after the original check
    // would still warn for '0' and pass a loop-wide assertion.
    for (const bad of ['0', '-5', 'soon', '', '0.5']) {
      warn.mockClear()
      process.env.LARGE_LLM_SCALEDOWN_SECONDS = bad
      expect(largeScaledownSeconds()).toBe(DEFAULT_LARGE_LLM_SCALEDOWN_SECONDS)
      expect(warn, `no warning for ${JSON.stringify(bad)}`).toHaveBeenCalledTimes(1)
    }
    warn.mockRestore()
  })

  it('floors a fractional window rather than refusing every fraction', () => {
    process.env.LARGE_LLM_SCALEDOWN_SECONDS = '1.5'
    expect(largeScaledownSeconds()).toBe(1)
  })
})

describe('largeWarmth', () => {
  it('reports unknown — NOT cold — before this process has seen a call', () => {
    // The distinction is the point: another instance may be keeping the box
    // warm, and presenting that guess as "cold" would be a measurement the
    // process never made.
    expect(largeWarmth(NOW)).toEqual({
      state: 'unknown',
      secondsUntilScaledown: null,
      scaledownSeconds: 300,
    })
  })

  it('is warm with a countdown inside the scale-down window', () => {
    noteLargeCallCompleted(NOW)
    expect(largeWarmth(NOW + 30_000)).toMatchObject({
      state: 'warm',
      secondsUntilScaledown: 270,
    })
  })

  it('rounds the countdown UP, so it never shows 0 while still warm', () => {
    noteLargeCallCompleted(NOW)
    expect(largeWarmth(NOW + 299_500).secondsUntilScaledown).toBe(1)
  })

  it('goes cold exactly at the window, and stays cold', () => {
    noteLargeCallCompleted(NOW)
    expect(largeWarmth(NOW + 300_000).state).toBe('cold')
    expect(largeWarmth(NOW + 10_000_000)).toEqual({
      state: 'cold',
      secondsUntilScaledown: null,
      scaledownSeconds: 300,
    })
  })

  it('follows the configured window rather than the default', () => {
    process.env.LARGE_LLM_SCALEDOWN_SECONDS = '900'
    noteLargeCallCompleted(NOW)
    expect(largeWarmth(NOW + 300_000)).toMatchObject({
      state: 'warm',
      secondsUntilScaledown: 600,
      scaledownSeconds: 900,
    })
  })

  it('reports running while a turn is in flight, with no countdown ticking down', () => {
    // Scale-down cannot happen while work is on the box, so a countdown here
    // would be counting towards something that will not occur.
    noteLargeCallCompleted(NOW)
    beginSelfDeployedTurn()
    const warmth = largeWarmth(NOW + 295_000)
    expect(warmth.state).toBe('running')
    expect(warmth.secondsUntilScaledown).toBe(300)
  })

  it('reports STARTING, not running, when nothing proves the box was up', () => {
    // The first turn against a scaled-to-zero deployment: in flight, nothing
    // completed. `running` is documented as "implies warm" and renders a full
    // countdown, so claiming it here tells the sender the box is up while they
    // pay the multi-minute cold start this indicator exists to warn about —
    // and tells everyone else reading the strip to send into the same wait.
    beginSelfDeployedTurn()
    expect(largeWarmth(NOW)).toMatchObject({
      state: 'starting',
      secondsUntilScaledown: null,
    })
  })

  it('reports STARTING when the last completed call is older than the window', () => {
    // Same claim, reached the other way: the box scaled down at some point
    // after that call, so this turn is paying a cold start too. Only a call
    // inside the window is evidence of warmth.
    noteLargeCallCompleted(NOW)
    beginSelfDeployedTurn()
    expect(largeWarmth(NOW + 301_000).state).toBe('starting')
  })

  it('returns to the countdown when the turn ends', () => {
    noteLargeCallCompleted(NOW)
    beginSelfDeployedTurn()
    endSelfDeployedTurn()
    expect(largeWarmth(NOW + 60_000)).toMatchObject({
      state: 'warm',
      secondsUntilScaledown: 240,
    })
  })

  it('tracks concurrent turns rather than the last one to finish', () => {
    noteLargeCallCompleted(NOW)
    beginSelfDeployedTurn()
    beginSelfDeployedTurn()
    endSelfDeployedTurn()
    expect(largeWarmth(NOW).state).toBe('running')
    endSelfDeployedTurn()
    expect(largeWarmth(NOW).state).toBe('warm')
  })

  it('clamps the in-flight gauge at zero, so a later turn still registers', () => {
    // Pins the `Math.max(0, ...)` in `endSelfDeployedTurn` from the other side. Without
    // it, two mispaired decrements leave the gauge at -2 and the NEXT genuine
    // turn reads as no turn at all — the header would go quiet for the run it
    // exists to report. The test below covers the direction that stays stuck ON.
    endSelfDeployedTurn()
    endSelfDeployedTurn()
    beginSelfDeployedTurn()
    expect(largeWarmth(NOW).state).toBe('starting')
  })

  it('cannot be pinned to running by an unbalanced decrement', () => {
    // A mispaired end (a throw that skipped the increment) must not push the
    // gauge negative, or every later turn would leave it stuck above zero.
    endSelfDeployedTurn()
    endSelfDeployedTurn()
    beginSelfDeployedTurn()
    endSelfDeployedTurn()
    expect(largeWarmth(NOW).state).toBe('unknown')
  })

  it('does NOT invent warmth when a turn ends without a large-box call', () => {
    // Only a sample naming LargeQwen stamps the clock. An approval that
    // resolved with no LLM step must not leave the header claiming the box is
    // up for three minutes.
    beginSelfDeployedTurn()
    endSelfDeployedTurn()
    expect(largeWarmth(NOW).state).toBe('unknown')
  })
})

// The up-since clock (#1047 round 4): when this process first observed the
// box UP in its current up-period. The admin meter seeds each box's accrual
// from max(upSince, switch-on), so what must hold is that the value OPENS at
// the first answer after cold, does NOT move with the keep-warm pings that
// refresh `lastCompletedAt` (roughly every 100s — a meter seeded from THAT
// re-billed a whole switch-on as ~zero on every reload, the round-3 defect),
// and CLOSES with the idle window. Process-local: a restart loses it, and the
// meter then starts from its own observation — under-stating, which is the
// direction a floor may err in.
describe('largeUpSince', () => {
  it('is null before this process has seen an answer — the state a restart leaves', () => {
    expect(largeUpSince(NOW)).toBeNull()
  })

  it('opens at the first answer after cold, and stays while the window holds', () => {
    noteLargeCallCompleted(NOW)
    expect(largeUpSince(NOW)).toBe(NOW)
    // A later read inside the window sees the same period, not a new one.
    expect(largeUpSince(NOW + 60_000)).toBe(NOW)
  })

  it('does NOT move with later answers inside the window — the keep-warm pings', () => {
    // The pings answer roughly every 100s against a 300s window: each is
    // inside the period the previous answer holds open. MUTATION: stamp
    // `upSince` on every completion (i.e. seed the meter from
    // `lastCompletedAt`) and this reddens — the ping wins and a reload
    // re-bills from the last one.
    noteLargeCallCompleted(NOW)
    noteLargeCallCompleted(NOW + 100_000)
    noteLargeCallCompleted(NOW + 200_000)
    expect(largeUpSince(NOW + 240_000)).toBe(NOW)
  })

  it('re-opens at the first answer after the window passed — a new up-period', () => {
    // 400s between answers against the 300s window: the box went cold in
    // between, so the second answer is its OWN period's start, not a
    // continuation of the first.
    noteLargeCallCompleted(NOW)
    noteLargeCallCompleted(NOW + 400_000)
    expect(largeUpSince(NOW + 500_000)).toBe(NOW + 400_000)
  })

  it('clears once the window has passed the last answer — the read is what clears', () => {
    noteLargeCallCompleted(NOW)
    expect(largeUpSince(NOW + 299_000)).toBe(NOW)
    // Exactly past the window: not provably up, so no up-period is open.
    expect(largeUpSince(NOW + 300_000)).toBeNull()
    // And the closed period's start is GONE, not merely withheld: a stale
    // stored value must never come back as the start of a period this
    // process cannot prove is open.
    expect(largeUpSince(NOW + 299_000)).toBeNull()
  })

  it('reads through a running turn — the answering state the meter counts', () => {
    // A turn in flight WITH warm evidence is `answering`, and the meter
    // counts the 27B while it reads that, so the seed must be readable
    // there too — the same warm evidence, not a different rule.
    noteLargeCallCompleted(NOW)
    beginSelfDeployedTurn()
    try {
      expect(largeWarmth(NOW + 60_000).state).toBe('running')
      expect(largeUpSince(NOW + 60_000)).toBe(NOW)
    } finally {
      endSelfDeployedTurn()
    }
  })

  it('stays null for a starting turn — no evidence the box is up', () => {
    // A turn in flight WITHOUT warm evidence is `starting`: it claims
    // nothing, and neither does the up-since — the cold start it may end in
    // is not billed time.
    beginSelfDeployedTurn()
    try {
      expect(largeWarmth(NOW).state).toBe('starting')
      expect(largeUpSince(NOW)).toBeNull()
    } finally {
      endSelfDeployedTurn()
    }
  })
})
