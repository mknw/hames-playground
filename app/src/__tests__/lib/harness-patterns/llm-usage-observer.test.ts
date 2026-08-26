/**
 * LLM-usage observer + the accounting chokepoint.
 *
 * The observer sits on the answer path of EVERY BAML call and its stated
 * guarantee is a negative one — "a throwing listener never breaks a turn" — so
 * it had no test at all while reading as covered: v8 marks its loop executed
 * because every other test in the repo runs it with zero listeners registered,
 * which never enters the `catch`.
 *
 * The second half is the property the preview header's on-prem share depends
 * on: accounting coverage has to be uniform across ROLES. A role that spends
 * tokens without being counted disappears from the denominator, and since the
 * uncounted roles (describe, screen) were the Anthropic-only ones, the share
 * read higher than the truth. The last test is a source scan rather than a
 * behavioural one, because the failure mode is a NEW call site that forgets —
 * which no amount of testing the existing ones catches.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Collector } from '@boundaryml/baml'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

import {
  notifyLlmUsage,
  observeLlmUsage,
  resetLlmUsageObservers,
  type LlmUsageSample,
} from '../../../lib/harness-patterns/llm-usage-observer.server'
import {
  accountBamlCall,
  withUsageAccounting,
} from '../../../lib/harness-patterns/baml-adapters.server'

/** A collector as `accountBamlCall` reads it: one log, one selected call with
 *  usage. Enough for `computeEventMetrics` to count one attempt. */
function stubCollector(
  clientName: string,
  inputTokens = 10,
  outputTokens = 5,
  timing?: { durationMs: number | null },
): Collector {
  const call = {
    selected: true,
    provider: 'anthropic',
    clientName,
    httpResponse: null,
    usage: { inputTokens, outputTokens, cachedInputTokens: 0 },
  }
  const log = {
    calls: [call],
    usage: { inputTokens, outputTokens, cachedInputTokens: 0 },
    ...(timing ? { timing } : {}),
  }
  return { last: log, logs: [log] } as unknown as Collector
}

afterEach(() => {
  resetLlmUsageObservers()
  vi.restoreAllMocks()
})

describe('llm-usage observer', () => {
  it('delivers a sample to every registered listener', () => {
    const a: LlmUsageSample[] = []
    const b: LlmUsageSample[] = []
    observeLlmUsage((s) => a.push(s))
    observeLlmUsage((s) => b.push(s))

    notifyLlmUsage({ functionName: 'LoopController', clientName: 'VerdaQwen' })

    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
    expect(a[0].clientName).toBe('VerdaQwen')
  })

  it('is a no-op with no listeners — the normal state everywhere but production', () => {
    expect(() => notifyLlmUsage({ functionName: 'Critic' })).not.toThrow()
  })

  it('never lets a throwing listener break the turn, and says so in the log', () => {
    // The whole point: bookkeeping is not worth an answer. A swallowed-silently
    // failure would be worse — a counter that stops counting reads as "nothing
    // happened today", which the absence of the number would not have claimed.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const after: LlmUsageSample[] = []
    observeLlmUsage(() => {
      throw new Error('counter is down')
    })
    observeLlmUsage((s) => after.push(s))

    expect(() => notifyLlmUsage({ functionName: 'Synthesize' })).not.toThrow()
    // A listener registered AFTER the throwing one still runs.
    expect(after).toHaveLength(1)
    expect(err).toHaveBeenCalledOnce()
    expect(String(err.mock.calls[0][0])).toContain('not recorded')
  })

  it('stops delivering once the disposer runs, and only to that listener', () => {
    const kept: LlmUsageSample[] = []
    const dropped: LlmUsageSample[] = []
    const dispose = observeLlmUsage((s) => dropped.push(s))
    observeLlmUsage((s) => kept.push(s))

    dispose()
    notifyLlmUsage({ functionName: 'Router' })

    expect(dropped).toHaveLength(0)
    expect(kept).toHaveLength(1)
  })
})

describe('accountBamlCall — the one place usage is stamped', () => {
  let samples: LlmUsageSample[]
  beforeEach(() => {
    samples = []
    observeLlmUsage((s) => samples.push(s))
  })

  it('reports the client BAML SELECTED, with the step metrics', () => {
    accountBamlCall(stubCollector('VerdaQwen', 100, 40), 'LoopController')

    expect(samples).toHaveLength(1)
    expect(samples[0]).toMatchObject({ functionName: 'LoopController', clientName: 'VerdaQwen' })
    expect(samples[0].metrics).toMatchObject({ inputUncachedTokens: 100, outputTokens: 40 })
  })

  it('prefers metrics the caller already computed over recomputing them', () => {
    // The two extractors have summed the collector already; recomputing would
    // be the same number for twice the work, and a DIFFERENT number is a bug
    // worth seeing rather than averaging away.
    accountBamlCall(stubCollector('AnthropicSonnet5'), 'Critic', {
      inputUncachedTokens: 7,
      inputCacheReadTokens: 0,
      inputCacheWriteTokens: 0,
      outputTokens: 3,
      attempts: 1,
    })

    expect(samples[0].metrics).toMatchObject({ inputUncachedTokens: 7, outputTokens: 3 })
  })

  it('reports the duration BAML measured, so a rolling latency can be taken', () => {
    accountBamlCall(stubCollector('VerdaQwen', 100, 40, { durationMs: 4123 }), 'LoopController')
    expect(samples[0].durationMs).toBe(4123)
  })

  it('leaves the duration ABSENT when BAML measured none', () => {
    // A 0 here would enter a rolling median as an instant call. Undefined is
    // the honest reading of "not measured", and the consumer drops it.
    accountBamlCall(stubCollector('VerdaQwen', 100, 40, { durationMs: null }), 'LoopController')
    expect(samples[0].durationMs).toBeUndefined()

    // Same for a collector with no timing at all, which is what a stub — and a
    // client version that stops reporting it — looks like.
    accountBamlCall(stubCollector('VerdaQwen'), 'Critic')
    expect(samples[1].durationMs).toBeUndefined()
  })

  it('stays silent when the call never reached a model', () => {
    // A pre-flight failure spent nothing; a sample here would add a call to the
    // denominator that no provider ever saw.
    accountBamlCall(undefined, 'Synthesize')
    accountBamlCall({ last: null, logs: [] } as unknown as Collector, 'Synthesize')

    expect(samples).toHaveLength(0)
  })
})

describe('withUsageAccounting', () => {
  let samples: LlmUsageSample[]
  beforeEach(() => {
    samples = []
    observeLlmUsage((s) => samples.push(s))
  })

  it('hands the call a collector and returns its result untouched', async () => {
    let seen: unknown
    const out = await withUsageAccounting('ResultDescribe', async (opts) => {
      seen = opts.collector
      return 'a summary'
    })

    expect(out).toBe('a summary')
    expect(seen).toBeDefined()
  })

  it('accounts a call that THREW after reaching the model', async () => {
    // Same rule `extractFailureLLMCallData` follows: a failed call was still
    // billed, and for the self-hosted box it woke the GPU exactly as much.
    const collector = stubCollector('AnthropicHaiku45')
    await expect(
      withUsageAccounting('ScreenUntrustedContent', async (opts) => {
        // Give the fresh collector the readings a real call would have left,
        // then fail — the shape a BAML throw after a billed attempt leaves
        // behind. `last`/`logs` are prototype getters, hence defineProperty.
        const readings = collector as unknown as { last: unknown; logs: unknown }
        Object.defineProperty(opts.collector, 'last', { get: () => readings.last })
        Object.defineProperty(opts.collector, 'logs', { get: () => readings.logs })
        throw new Error('screen unavailable')
      }),
    ).rejects.toThrow('screen unavailable')

    expect(samples).toHaveLength(1)
    expect(samples[0].functionName).toBe('ScreenUntrustedContent')
  })
})

describe('accounting coverage across roles', () => {
  const LIB = join(process.cwd(), 'src', 'lib')

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full, out)
      else if (full.endsWith('.ts')) out.push(full)
    }
    return out
  }

  /**
   * Call sites deliberately NOT accounted, each with the reason. One entry
   * today, and it is the manual load-measurement script below — every path a
   * turn can take is accounted. An entry here is a decision, not a default,
   * because the cost of forgetting is invisible: an uncounted role does not
   * lose detail, it silently biases the on-prem share the whole preview exists
   * to show.
   */
  const UNACCOUNTED: Record<string, string> = {
    'src/lib/harness-patterns/scripts/smoke-verda-load.ts:LoopController':
      'A manual live-load measurement run by hand against the endpoint, not a path any turn ' +
      'takes. Counting it would put a benchmark burst into the preview header as if users had ' +
      'spent it. Excluded from coverage for the same reason.',
  }

  it('every BAML function called under src/lib is named at an accounting site', () => {
    // A source scan rather than a behavioural test, because the failure mode is
    // the NEXT call site, not any of the current ones. Matched per FUNCTION
    // NAME, not per file: `baml-adapters.server.ts` accounts for most of the
    // repo's calls, so "this file mentions an accounting helper somewhere"
    // would pass a brand-new unaccounted call sitting right beside them.
    const ACCOUNTERS =
      /(?:extractLLMCallData|extractFailureLLMCallData|wrapAsLLMCallError|accountBamlCall|withUsageAccounting)\(([^)]*)/g
    const offenders: string[] = []

    for (const file of walk(LIB)) {
      const source = readFileSync(file, 'utf8')
      const called = new Set([...source.matchAll(/\bb\.([A-Z]\w+)\s*\(/g)].map((m) => m[1]))
      if (called.size === 0) continue
      const accounted = new Set(
        [...source.matchAll(ACCOUNTERS)].flatMap((m) =>
          [...m[1].matchAll(/'([A-Za-z]\w+)'/g)].map((n) => n[1]),
        ),
      )
      const rel = file.slice(process.cwd().length + 1)
      for (const fn of called) {
        if (accounted.has(fn)) continue
        if (UNACCOUNTED[`${rel}:${fn}`]) continue
        offenders.push(`${rel}: b.${fn}()`)
      }
    }

    expect(offenders).toEqual([])
  })
})
