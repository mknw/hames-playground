/**
 * Usage recorder — the bridge from a finished BAML call to the header's two
 * numbers.
 *
 * The claim this file has to defend is that the self-hosted SHARE is evidence
 * rather than intention: it is derived from the client BAML actually selected,
 * so a routing change that reads like it moved traffic but did not cannot
 * inflate it. Everything else here is the batching, which trades exactness for
 * one write per turn and must say so in the honest direction (never counting
 * more than was spent).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

const addUsage = vi.fn<(delta: unknown, now?: number) => Promise<void>>(async () => {})
vi.mock('../../../lib/metrics/preview-counters.server', () => ({
  addUsage: (delta: unknown, now?: number) => addUsage(delta, now),
}))

import {
  flushUsage,
  installUsageRecorder,
  recordSample,
  recordTurn,
  tierOfSample,
} from '../../../lib/metrics/usage-recorder.server'
import {
  notifyLlmUsage,
  resetLlmUsageObservers,
} from '../../../lib/harness-patterns/llm-usage-observer.server'
import { resetVerdaActivity, verdaWarmth } from '../../../lib/inference/verda-activity.server'
import { resetCallLatency, tierLatency } from '../../../lib/metrics/call-latency.server'
import type { EventMetrics } from '../../../lib/harness-patterns/types'

const metrics = (over: Partial<EventMetrics> = {}): EventMetrics => ({
  inputUncachedTokens: 100,
  inputCacheReadTokens: 10,
  inputCacheWriteTokens: 5,
  outputTokens: 20,
  attempts: 1,
  ...over,
})

beforeEach(async () => {
  addUsage.mockReset()
  addUsage.mockResolvedValue(undefined)
  resetVerdaActivity()
  resetCallLatency()
  await flushUsage() // drain anything a previous case left pending
  addUsage.mockReset()
})

/** The delta written for `tier`, or undefined if none was. */
function written(tier: string): Record<string, unknown> | undefined {
  return addUsage.mock.calls
    .map(([delta]) => delta as Record<string, unknown>)
    .find((delta) => delta.tier === tier)
}

describe('tierOfSample — the selected client is the evidence', () => {
  it('attributes a VerdaQwen call to the self-hosted tier', () => {
    expect(tierOfSample({ functionName: 'LoopController', clientName: 'VerdaQwen' })).toBe('verda')
  })

  it('attributes everything else to Anthropic, including an unnamed client', () => {
    expect(tierOfSample({ functionName: 'Router', clientName: 'RouterAnthropic' })).toBe(
      'anthropic',
    )
    expect(tierOfSample({ functionName: 'Router' })).toBe('anthropic')
    // Near-misses are not the self-hosted box. A prefix match would let a
    // future `VerdaQwenSomethingElse` silently join the confidential tier.
    expect(tierOfSample({ functionName: 'X', clientName: 'VerdaQwenPreview' })).toBe('anthropic')
  })
})

describe('recordSample', () => {
  it('sums every input bucket, not just the uncached one', async () => {
    // Cache reads and writes are tokens the deployment processed. Counting
    // only `inputUncachedTokens` would understate a cached conversation by
    // most of its input.
    recordSample({
      functionName: 'LoopController',
      clientName: 'AnthropicSonnet5',
      metrics: metrics(),
    })
    await flushUsage()

    expect(written('anthropic')).toMatchObject({
      llmCalls: 1,
      inputTokens: 115,
      outputTokens: 20,
    })
  })

  it('accumulates several calls into one write', async () => {
    for (let i = 0; i < 3; i++) {
      recordSample({ functionName: 'LoopController', clientName: 'VerdaQwen', metrics: metrics() })
    }
    await flushUsage()

    expect(addUsage).toHaveBeenCalledTimes(1)
    expect(written('verda')).toMatchObject({ llmCalls: 3, inputTokens: 345, outputTokens: 60 })
  })

  it('keeps the two tiers in separate rows', async () => {
    recordSample({ functionName: 'A', clientName: 'VerdaQwen', metrics: metrics() })
    recordSample({ functionName: 'B', clientName: 'DescribeAnthropic', metrics: metrics() })
    await flushUsage()

    expect(addUsage).toHaveBeenCalledTimes(2)
    expect(written('verda')).toMatchObject({ llmCalls: 1 })
    expect(written('anthropic')).toMatchObject({ llmCalls: 1 })
  })

  it('counts a call that spent nothing as no call at all', async () => {
    // A pre-flight throw never reached a model; counting it would inflate both
    // the call count and the denominator of the self-hosted share.
    recordSample({ functionName: 'LoopController', clientName: 'VerdaQwen' })
    await flushUsage()
    expect(addUsage).not.toHaveBeenCalled()
  })

  it('stamps the warm clock for a Verda call, and only for a Verda call', () => {
    const NOW = 1_700_000_000_000
    recordSample({ functionName: 'A', clientName: 'AnthropicSonnet5', metrics: metrics() }, NOW)
    expect(verdaWarmth(NOW).state).toBe('unknown')

    recordSample({ functionName: 'B', clientName: 'VerdaQwen', metrics: metrics() }, NOW)
    expect(verdaWarmth(NOW)).toMatchObject({ state: 'warm', secondsUntilScaledown: 180 })
  })

  it('stamps the clock even for a call that failed', () => {
    // A failed call woke the box exactly as much as a successful one, and the
    // failure path (`extractFailureLLMCallData`) notifies too. Reporting cold
    // here would send the next user into a cold start that will not happen.
    const NOW = 1_700_000_000_000
    recordSample({ functionName: 'B', clientName: 'VerdaQwen' }, NOW)
    expect(verdaWarmth(NOW).state).toBe('warm')
  })
})

describe('recordSample — the latency window', () => {
  it('records the call duration against the tier the client proves', () => {
    recordSample({ functionName: 'LoopController', clientName: 'VerdaQwen', durationMs: 4100 })
    recordSample({ functionName: 'Critic', clientName: 'AnthropicSonnet5', durationMs: 900 })

    expect(tierLatency('verda')).toEqual({ p50Ms: 4100, samples: 1 })
    expect(tierLatency('anthropic')).toEqual({ p50Ms: 900, samples: 1 })
  })

  it('counts only the roles a tier decision moves, so the two windows compare', () => {
    // The number sits beside the switch and is read as "this tier vs the other
    // one". `router`, `describe`, `screen` and `planner` run on Anthropic in
    // BOTH positions, so counting them would leave the anthropic window holding
    // a different role mix from the verda one — and in a verda-default
    // deployment, NOTHING BUT the cheap side-roles. A user would then read a
    // role-mix difference as a model difference.
    recordSample({ functionName: 'Router', clientName: 'RouterAnthropic', durationMs: 300 })
    recordSample({
      functionName: 'ResultDescribe',
      clientName: 'DescribeAnthropic',
      durationMs: 400,
    })
    recordSample({
      functionName: 'ScreenUntrustedContent',
      clientName: 'DescribeAnthropic',
      durationMs: 500,
    })
    recordSample({ functionName: 'Planner', clientName: 'PlannerAnthropic', durationMs: 9000 })
    expect(tierLatency('anthropic')).toEqual({ p50Ms: null, samples: 0 })

    // ...and all four switched functions do land, on whichever tier ran them.
    for (const fn of ['LoopController', 'ActorController', 'Critic', 'Synthesize']) {
      recordSample({ functionName: fn, clientName: 'AnthropicSonnet5', durationMs: 1000 })
    }
    expect(tierLatency('anthropic').samples).toBe(4)
  })

  it('records the wait for a call that spent no tokens', () => {
    // The metrics gate below it drops this sample from the token counters — it
    // reached a model and failed. But the user waited for it, and keeping only
    // the calls that went well would bias the median towards the good ones.
    recordSample({ functionName: 'LoopController', clientName: 'VerdaQwen', durationMs: 30_000 })
    expect(tierLatency('verda')).toEqual({ p50Ms: 30_000, samples: 1 })
  })

  it('records nothing when BAML measured nothing', () => {
    // Absent, not zero: a pre-flight failure has no duration, and a 0 would
    // read as an instant call.
    recordSample({ functionName: 'LoopController', clientName: 'VerdaQwen', metrics: metrics() })
    expect(tierLatency('verda')).toEqual({ p50Ms: null, samples: 0 })
  })
})

describe('recordTurn', () => {
  it('counts a turn against its tier without needing an LLM call', async () => {
    recordTurn('verda')
    await flushUsage()
    expect(written('verda')).toMatchObject({ turns: 1, llmCalls: 0 })
  })
})

describe('flushUsage', () => {
  it('does nothing when there is nothing pending', async () => {
    await flushUsage()
    expect(addUsage).not.toHaveBeenCalled()
  })

  it('clears the pending deltas, so a second flush does not double-count', async () => {
    recordSample({ functionName: 'A', clientName: 'VerdaQwen', metrics: metrics() })
    await flushUsage()
    addUsage.mockClear()

    await flushUsage()
    expect(addUsage).not.toHaveBeenCalled()
  })

  it('drops a delta whose write failed rather than retrying it forever', async () => {
    // A retry queue in the path of every turn is a memory leak; the counters
    // are documented as "at most what was spent" for exactly this.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    addUsage.mockRejectedValueOnce(new Error('postgres is down'))
    recordSample({ functionName: 'A', clientName: 'VerdaQwen', metrics: metrics() })

    await expect(flushUsage()).resolves.toBeUndefined()
    expect(error).toHaveBeenCalled()

    addUsage.mockClear()
    addUsage.mockResolvedValue(undefined)
    await flushUsage()
    expect(addUsage).not.toHaveBeenCalled()
    error.mockRestore()
  })
})

describe('installUsageRecorder', () => {
  beforeEach(() => {
    resetLlmUsageObservers()
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('kg-agent.usage-recorder')]
  })

  it('registers exactly one listener however many times it is called', async () => {
    // A dev-server reload re-evaluates the module. Without the install flag the
    // second pass stacks a SECOND listener and every later call is counted
    // twice — silently, and only in dev, where nobody is reading the counter.
    installUsageRecorder(60_000)
    installUsageRecorder(60_000)
    installUsageRecorder(60_000)

    notifyLlmUsage({
      functionName: 'LoopController',
      clientName: 'VerdaQwen',
      metrics: metrics({
        inputUncachedTokens: 100,
        inputCacheReadTokens: 0,
        inputCacheWriteTokens: 0,
        outputTokens: 20,
      }),
    })
    await flushUsage()

    expect(addUsage).toHaveBeenCalledOnce()
    expect(addUsage.mock.calls[0][0]).toMatchObject({
      tier: 'verda',
      llmCalls: 1,
      inputTokens: 100,
      outputTokens: 20,
    })
  })

  it('subscribes to the observer at all', () => {
    // The registration itself is production's only wiring; every other test in
    // this file calls `recordSample` directly and would pass without it.
    installUsageRecorder(60_000)
    notifyLlmUsage({ functionName: 'X', clientName: 'VerdaQwen', metrics: metrics() })
    expect(verdaWarmth().state).not.toBe('unknown')
  })
})
