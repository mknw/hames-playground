/**
 * Verda warm-state — the countdown the header renders, and the two ways it
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
  noteSelfDeployedCallCompleted,
  resetSelfDeployedActivity,
  selfDeployedScaledownSeconds,
  selfDeployedWarmth,
} from '../../../lib/inference/self-deployed-activity.server'

const NOW = 1_700_000_000_000

beforeEach(() => {
  resetSelfDeployedActivity()
  delete process.env.LARGE_LLM_SCALEDOWN_SECONDS
})

afterEach(() => {
  resetSelfDeployedActivity()
  delete process.env.LARGE_LLM_SCALEDOWN_SECONDS
})

describe('selfDeployedScaledownSeconds', () => {
  it('defaults to the deployment’s current 300s', () => {
    // Owner-confirmed 2026-08-26. Pinned as a literal, not just as "whatever
    // the constant says": the countdown is a claim about a deployment the app
    // cannot interrogate, so the number is the assertion. `app/.env.example`
    // carries the same value uncommented and the two must not drift.
    expect(selfDeployedScaledownSeconds()).toBe(DEFAULT_LARGE_LLM_SCALEDOWN_SECONDS)
    expect(DEFAULT_LARGE_LLM_SCALEDOWN_SECONDS).toBe(300)
  })

  it('takes the env value, so production can raise it without a rebuild', () => {
    process.env.LARGE_LLM_SCALEDOWN_SECONDS = '900'
    expect(selfDeployedScaledownSeconds()).toBe(900)
  })

  it('falls back rather than rendering "scaling down now, forever"', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const bad of ['0', '-5', 'soon', '']) {
      process.env.LARGE_LLM_SCALEDOWN_SECONDS = bad
      expect(selfDeployedScaledownSeconds()).toBe(DEFAULT_LARGE_LLM_SCALEDOWN_SECONDS)
    }
    // A silent fallback would hide a misconfigured deployment behind a
    // plausible countdown.
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('selfDeployedWarmth', () => {
  it('reports unknown — NOT cold — before this process has seen a call', () => {
    // The distinction is the point: another instance may be keeping the box
    // warm, and presenting that guess as "cold" would be a measurement the
    // process never made.
    expect(selfDeployedWarmth(NOW)).toEqual({
      state: 'unknown',
      secondsUntilScaledown: null,
      scaledownSeconds: 300,
    })
  })

  it('is warm with a countdown inside the scale-down window', () => {
    noteSelfDeployedCallCompleted(NOW)
    expect(selfDeployedWarmth(NOW + 30_000)).toMatchObject({
      state: 'warm',
      secondsUntilScaledown: 270,
    })
  })

  it('rounds the countdown UP, so it never shows 0 while still warm', () => {
    noteSelfDeployedCallCompleted(NOW)
    expect(selfDeployedWarmth(NOW + 299_500).secondsUntilScaledown).toBe(1)
  })

  it('goes cold exactly at the window, and stays cold', () => {
    noteSelfDeployedCallCompleted(NOW)
    expect(selfDeployedWarmth(NOW + 300_000).state).toBe('cold')
    expect(selfDeployedWarmth(NOW + 10_000_000)).toEqual({
      state: 'cold',
      secondsUntilScaledown: null,
      scaledownSeconds: 300,
    })
  })

  it('follows the configured window rather than the default', () => {
    process.env.LARGE_LLM_SCALEDOWN_SECONDS = '900'
    noteSelfDeployedCallCompleted(NOW)
    expect(selfDeployedWarmth(NOW + 300_000)).toMatchObject({
      state: 'warm',
      secondsUntilScaledown: 600,
      scaledownSeconds: 900,
    })
  })

  it('reports running while a turn is in flight, with no countdown ticking down', () => {
    // Scale-down cannot happen while work is on the box, so a countdown here
    // would be counting towards something that will not occur.
    noteSelfDeployedCallCompleted(NOW)
    beginSelfDeployedTurn()
    const warmth = selfDeployedWarmth(NOW + 295_000)
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
    expect(selfDeployedWarmth(NOW)).toMatchObject({
      state: 'starting',
      secondsUntilScaledown: null,
    })
  })

  it('reports STARTING when the last completed call is older than the window', () => {
    // Same claim, reached the other way: the box scaled down at some point
    // after that call, so this turn is paying a cold start too. Only a call
    // inside the window is evidence of warmth.
    noteSelfDeployedCallCompleted(NOW)
    beginSelfDeployedTurn()
    expect(selfDeployedWarmth(NOW + 301_000).state).toBe('starting')
  })

  it('returns to the countdown when the turn ends', () => {
    noteSelfDeployedCallCompleted(NOW)
    beginSelfDeployedTurn()
    endSelfDeployedTurn()
    expect(selfDeployedWarmth(NOW + 60_000)).toMatchObject({
      state: 'warm',
      secondsUntilScaledown: 240,
    })
  })

  it('tracks concurrent turns rather than the last one to finish', () => {
    noteSelfDeployedCallCompleted(NOW)
    beginSelfDeployedTurn()
    beginSelfDeployedTurn()
    endSelfDeployedTurn()
    expect(selfDeployedWarmth(NOW).state).toBe('running')
    endSelfDeployedTurn()
    expect(selfDeployedWarmth(NOW).state).toBe('warm')
  })

  it('clamps the in-flight gauge at zero, so a later turn still registers', () => {
    // Pins the `Math.max(0, ...)` in `endSelfDeployedTurn` from the other side. Without
    // it, two mispaired decrements leave the gauge at -2 and the NEXT genuine
    // turn reads as no turn at all — the header would go quiet for the run it
    // exists to report. The test below covers the direction that stays stuck ON.
    endSelfDeployedTurn()
    endSelfDeployedTurn()
    beginSelfDeployedTurn()
    expect(selfDeployedWarmth(NOW).state).toBe('starting')
  })

  it('cannot be pinned to running by an unbalanced decrement', () => {
    // A mispaired end (a throw that skipped the increment) must not push the
    // gauge negative, or every later turn would leave it stuck above zero.
    endSelfDeployedTurn()
    endSelfDeployedTurn()
    beginSelfDeployedTurn()
    endSelfDeployedTurn()
    expect(selfDeployedWarmth(NOW).state).toBe('unknown')
  })

  it('does NOT invent warmth when a turn ends without a Verda call', () => {
    // Only a sample naming SelfDeployedQwen stamps the clock. An approval that
    // resolved with no LLM step must not leave the header claiming the box is
    // up for three minutes.
    beginSelfDeployedTurn()
    endSelfDeployedTurn()
    expect(selfDeployedWarmth(NOW).state).toBe('unknown')
  })
})
