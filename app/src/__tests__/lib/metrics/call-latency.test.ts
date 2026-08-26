/**
 * Rolling per-tier call latency — the arithmetic and the window.
 *
 * Pure and process-local, so nothing is mocked but the server-only guard. What
 * each case guards is the set of ways a latency number lies:
 *   - an empty window must read "not measured", never 0 ms;
 *   - the median must be a duration something actually took (nearest-rank), not
 *     an interpolation between two calls;
 *   - the window must be bounded, or "rolling" is a claim the code does not
 *     keep and one cold start owns the median forever;
 *   - the two tiers must not bleed into each other — the whole point is to
 *     answer "how fast is THIS tier", and one shared window would answer
 *     neither;
 *   - an unmeasured reading (non-finite, negative) must be dropped, not
 *     clamped to 0, because a 0 in the window is a fast call that never
 *     happened.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

import {
  LATENCY_WINDOW,
  noteCallLatency,
  percentileMs,
  resetCallLatency,
  tierLatency,
} from '../../../lib/metrics/call-latency.server'

beforeEach(() => resetCallLatency())

describe('percentileMs', () => {
  it('is null for an empty set — "no calls yet" is not "0 ms"', () => {
    expect(percentileMs([], 0.5)).toBeNull()
  })

  it('takes the nearest rank, never an interpolation between two calls', () => {
    // Median of an EVEN set. The textbook average-of-the-two-middles answer
    // (2500) is a duration no call in this set ever recorded. Nearest rank is
    // the smallest sample with at least half the window at or below it, so it
    // is always one of the readings — here the lower of the two middles.
    expect(percentileMs([1000, 2000, 3000, 4000], 0.5)).toBe(2000)
    expect(percentileMs([1000, 2000, 3000], 0.5)).toBe(2000)
  })

  it('does not care what order the samples arrived in', () => {
    expect(percentileMs([4000, 1000, 3000, 2000, 900], 0.5)).toBe(2000)
    expect(percentileMs([900, 1000, 2000, 3000, 4000], 0.5)).toBe(2000)
  })

  it('reads a single sample as its own median', () => {
    expect(percentileMs([1234], 0.5)).toBe(1234)
  })

  it('clamps p into range and never indexes off either end', () => {
    const set = [10, 20, 30]
    expect(percentileMs(set, 0)).toBe(10)
    expect(percentileMs(set, -1)).toBe(10)
    expect(percentileMs(set, 1)).toBe(30)
    expect(percentileMs(set, 2)).toBe(30)
  })

  it('leaves its input alone — a sort in place would reorder the live window', () => {
    const set = [3000, 1000, 2000]
    percentileMs(set, 0.5)
    expect(set).toEqual([3000, 1000, 2000])
  })
})

describe('the rolling window', () => {
  it('reports no median and no samples before anything is recorded', () => {
    expect(tierLatency('verda')).toEqual({ p50Ms: null, samples: 0 })
  })

  it('keeps only the last LATENCY_WINDOW calls', () => {
    // A slow first call, then a full window of fast ones: the slow one must
    // have fallen out, or "rolling" means nothing.
    noteCallLatency('verda', 600_000)
    for (let i = 0; i < LATENCY_WINDOW; i++) noteCallLatency('verda', 4000)

    const { p50Ms, samples } = tierLatency('verda')
    expect(samples).toBe(LATENCY_WINDOW)
    expect(p50Ms).toBe(4000)
  })

  it('counts the samples the median is over, capped at the window', () => {
    for (let i = 0; i < LATENCY_WINDOW + 10; i++) noteCallLatency('anthropic', 1000 + i)
    expect(tierLatency('anthropic').samples).toBe(LATENCY_WINDOW)
  })

  it('keeps the tiers apart', () => {
    noteCallLatency('verda', 9000)
    noteCallLatency('anthropic', 1000)

    expect(tierLatency('verda')).toEqual({ p50Ms: 9000, samples: 1 })
    expect(tierLatency('anthropic')).toEqual({ p50Ms: 1000, samples: 1 })
  })

  it('includes a cold start rather than filtering it out', () => {
    // It is time a user waited. The warm indicator beside it is what says
    // which case they are looking at.
    noteCallLatency('verda', 4000)
    noteCallLatency('verda', 180_000)
    noteCallLatency('verda', 5000)
    expect(tierLatency('verda').p50Ms).toBe(5000)
  })

  it('drops an unmeasured reading instead of recording it as 0', () => {
    noteCallLatency('verda', 4000)
    noteCallLatency('verda', Number.NaN)
    noteCallLatency('verda', Number.POSITIVE_INFINITY)
    noteCallLatency('verda', -1)

    expect(tierLatency('verda')).toEqual({ p50Ms: 4000, samples: 1 })
  })

  it('accepts a genuine zero — a cache-served call is not an unmeasured one', () => {
    noteCallLatency('anthropic', 0)
    expect(tierLatency('anthropic')).toEqual({ p50Ms: 0, samples: 1 })
  })

  it('is emptied by the reset the tests share, so no case inherits a window', () => {
    noteCallLatency('verda', 1000)
    resetCallLatency()
    expect(tierLatency('verda').samples).toBe(0)
  })
})
