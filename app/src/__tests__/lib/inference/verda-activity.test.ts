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

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

import {
  DEFAULT_VERDA_SCALEDOWN_SECONDS,
  beginVerdaTurn,
  endVerdaTurn,
  noteVerdaCallCompleted,
  resetVerdaActivity,
  verdaScaledownSeconds,
  verdaWarmth,
} from '../../../lib/inference/verda-activity.server'

const NOW = 1_700_000_000_000

beforeEach(() => {
  resetVerdaActivity()
  delete process.env.VERDA_SCALEDOWN_SECONDS
})

afterEach(() => {
  resetVerdaActivity()
  delete process.env.VERDA_SCALEDOWN_SECONDS
})

describe('verdaScaledownSeconds', () => {
  it('defaults to the deployment’s current 180s', () => {
    expect(verdaScaledownSeconds()).toBe(DEFAULT_VERDA_SCALEDOWN_SECONDS)
    expect(DEFAULT_VERDA_SCALEDOWN_SECONDS).toBe(180)
  })

  it('takes the env value, so production can raise it without a rebuild', () => {
    process.env.VERDA_SCALEDOWN_SECONDS = '900'
    expect(verdaScaledownSeconds()).toBe(900)
  })

  it('falls back rather than rendering "scaling down now, forever"', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const bad of ['0', '-5', 'soon', '']) {
      process.env.VERDA_SCALEDOWN_SECONDS = bad
      expect(verdaScaledownSeconds()).toBe(DEFAULT_VERDA_SCALEDOWN_SECONDS)
    }
    // A silent fallback would hide a misconfigured deployment behind a
    // plausible countdown.
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('verdaWarmth', () => {
  it('reports unknown — NOT cold — before this process has seen a call', () => {
    // The distinction is the point: another instance may be keeping the box
    // warm, and presenting that guess as "cold" would be a measurement the
    // process never made.
    expect(verdaWarmth(NOW)).toEqual({
      state: 'unknown',
      secondsUntilScaledown: null,
      scaledownSeconds: 180,
    })
  })

  it('is warm with a countdown inside the scale-down window', () => {
    noteVerdaCallCompleted(NOW)
    expect(verdaWarmth(NOW + 30_000)).toMatchObject({
      state: 'warm',
      secondsUntilScaledown: 150,
    })
  })

  it('rounds the countdown UP, so it never shows 0 while still warm', () => {
    noteVerdaCallCompleted(NOW)
    expect(verdaWarmth(NOW + 179_500).secondsUntilScaledown).toBe(1)
  })

  it('goes cold exactly at the window, and stays cold', () => {
    noteVerdaCallCompleted(NOW)
    expect(verdaWarmth(NOW + 180_000).state).toBe('cold')
    expect(verdaWarmth(NOW + 10_000_000)).toEqual({
      state: 'cold',
      secondsUntilScaledown: null,
      scaledownSeconds: 180,
    })
  })

  it('follows the configured window rather than the default', () => {
    process.env.VERDA_SCALEDOWN_SECONDS = '600'
    noteVerdaCallCompleted(NOW)
    expect(verdaWarmth(NOW + 300_000)).toMatchObject({
      state: 'warm',
      secondsUntilScaledown: 300,
      scaledownSeconds: 600,
    })
  })

  it('reports running while a turn is in flight, with no countdown ticking down', () => {
    // Scale-down cannot happen while work is on the box, so a countdown here
    // would be counting towards something that will not occur.
    noteVerdaCallCompleted(NOW)
    beginVerdaTurn()
    const warmth = verdaWarmth(NOW + 175_000)
    expect(warmth.state).toBe('running')
    expect(warmth.secondsUntilScaledown).toBe(180)
  })

  it('reports running even when no call has completed yet', () => {
    // The first turn of a cold start: in flight, nothing finished. "unknown"
    // would be wrong — we know exactly what is happening.
    beginVerdaTurn()
    expect(verdaWarmth(NOW).state).toBe('running')
  })

  it('returns to the countdown when the turn ends', () => {
    noteVerdaCallCompleted(NOW)
    beginVerdaTurn()
    endVerdaTurn()
    expect(verdaWarmth(NOW + 60_000)).toMatchObject({ state: 'warm', secondsUntilScaledown: 120 })
  })

  it('tracks concurrent turns rather than the last one to finish', () => {
    beginVerdaTurn()
    beginVerdaTurn()
    endVerdaTurn()
    expect(verdaWarmth(NOW).state).toBe('running')
    endVerdaTurn()
    expect(verdaWarmth(NOW).state).toBe('unknown')
  })

  it('cannot be pinned to running by an unbalanced decrement', () => {
    // A mispaired end (a throw that skipped the increment) must not push the
    // gauge negative, or every later turn would leave it stuck above zero.
    endVerdaTurn()
    endVerdaTurn()
    beginVerdaTurn()
    endVerdaTurn()
    expect(verdaWarmth(NOW).state).toBe('unknown')
  })

  it('does NOT invent warmth when a turn ends without a Verda call', () => {
    // Only a sample naming VerdaQwen stamps the clock. An approval that
    // resolved with no LLM step must not leave the header claiming the box is
    // up for three minutes.
    beginVerdaTurn()
    endVerdaTurn()
    expect(verdaWarmth(NOW).state).toBe('unknown')
  })
})
