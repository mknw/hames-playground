/**
 * `model_call` — the screen and the describe calls as events of the run.
 *
 * Both calls return a bare value (a verdict, a summary string), so until now
 * their spend lived only in the process-wide usage counters: a run's
 * observability and cost summary never saw them. The seam is an optional
 * `onCall` sink handed to the injected function; core turns what it receives
 * into a `model_call` event. Core never sees a client name table or a price —
 * the record arrives priced (`metrics`) on the client that actually ran — so
 * what is pinned here is that the event is recorded, carries client and cost,
 * reaches the folds, survives a failed turn, and carries none of the content
 * the call read (SD-3).
 *
 * Also pinned: the boundary events `withReferences` and `parallel` stamp.
 * They are created after the wrapped work finishes, and were stamped there.
 *
 * Each test names the source mutation that reddens it; every one was run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { commitEvents, createContext, createModelCallEvent, createScope } from '../context.server'
import { compactBulkData } from '../compactBulkData.server'
import { createInjectionGuard } from '../patterns/withInjectionGuard.server'
import type { InjectionScreen } from '../injection-guard'
import { createEventView } from '../patterns/event-view.server'
import { parallel } from '../patterns/parallel.server'
import { withRunFrame } from '../run-frame.server'
import { __clearReferenceCache, withReferences } from '../patterns/with-references.server'
import { foldEvents } from '../metrics/aggregate'
import { foldTokenTotals } from '../observability/token-totals'
import { getEventPreview } from '../observability/projection'
import type {
  CallRecordSink,
  ConfiguredPattern,
  ContextEvent,
  EventMetrics,
  LLMCallRecord,
  PatternScope,
} from '../types'

const PAGE_TEXT = 'SENTINEL-PAGE-TEXT-7731'

/** What an implementation hands the sink: a full record, content included. */
function record(over: Partial<LLMCallRecord> & { metrics?: EventMetrics } = {}): LLMCallRecord {
  return {
    functionName: 'ScreenUntrustedContent',
    variables: { content: PAGE_TEXT },
    promptTemplate: `template ${PAGE_TEXT}`,
    rawInput: `{"messages":"${PAGE_TEXT}"}`,
    rawOutput: `reply ${PAGE_TEXT}`,
    parsedOutput: { reason: PAGE_TEXT },
    usage: {
      inputTokens: 1000,
      outputTokens: 100,
      cachedInputTokens: 0,
      totalTokens: 1100,
    },
    durationMs: 3600,
    provider: 'openai-generic',
    clientName: 'LargeQwen',
    metrics: {
      inputUncachedTokens: 1000,
      inputCacheReadTokens: 0,
      inputCacheWriteTokens: 0,
      outputTokens: 100,
      attempts: 1,
      costEur: 0.0018,
      noCacheEur: 0.0018,
      basis: 'time',
      timePricedAttempts: 1,
      timeRate: { eurPerHour: 1.819, durationMs: 3600 },
    },
    ...over,
  }
}

const modelCalls = (events: ContextEvent[]): ContextEvent[] =>
  events.filter((e) => e.type === 'model_call')

// ============================================================================
// The screen, through the guard
// ============================================================================

describe('the guard records the screen call', () => {
  const clean = { injection_detected: false, reason: 'clean', spans: [] }
  const guardWith = (run: InjectionScreen) => {
    const events: ContextEvent[] = []
    const guard = createInjectionGuard(
      { tools: ['fetch_content'], screen: { run } },
      (e) => events.push(e),
      'guard',
    )
    return { guard, events }
  }

  // Mutation: drop `onCall` from the object the guard passes to `screen` →
  // the screen has no sink to report to and no `model_call` is recorded.
  it('emits a model_call with the client and cost for a screen that found nothing', async () => {
    const { guard, events } = guardWith(async ({ onCall }) => {
      onCall?.(record())
      return clean
    })

    await guard.sanitize('fetch_content', 'a page')

    const [call] = modelCalls(events)
    expect(modelCalls(events)).toHaveLength(1)
    expect(call.data).toEqual({ role: 'screen', source: 'fetch/fetch_content' })
    expect(call.patternId).toBe('guard')
    expect(call.llmCall?.clientName).toBe('LargeQwen')
    expect(call.llmCall?.functionName).toBe('ScreenUntrustedContent')
    // Lifted onto the event, which is what every cost fold reads.
    expect(call.metrics).toMatchObject({ costEur: 0.0018, basis: 'time' })
  })

  // Mutation: build the event only on the success path (move the `emit` out of
  // `onCall` into the code after `await options.screen(...)`) → a screen that
  // threw after being billed leaves no record.
  it('records a screen call that failed, beside the outage it caused', async () => {
    const { guard, events } = guardWith(async ({ onCall }) => {
      onCall?.(record())
      throw new Error('screen unavailable')
    })

    const { summary } = await guard.sanitize('fetch_content', 'a page')

    expect(modelCalls(events)).toHaveLength(1)
    expect(events.map((e) => e.type)).toContain('content_sanitized')
    expect(summary?.screenUnavailable).toBe(true)
  })

  it('invents no event for a screen that reports no call', async () => {
    const { guard, events } = guardWith(async () => clean)
    await guard.sanitize('fetch_content', 'a page')
    expect(modelCalls(events)).toHaveLength(0)
  })

  // Mutation: drop the try/catch around `emit` in the guard's `onCall` → a
  // screen with no catch of its own (anything but the BAML adapter) lets the
  // recording failure reach the guard's `catch`, which reports the screen as
  // unavailable and, on general-next, withholds a clean page.
  it('a recorder that throws changes neither the verdict nor the content', async () => {
    const injected = { injection_detected: false, reason: 'clean', spans: [] }
    const run = async (throwing: boolean) => {
      const events: ContextEvent[] = []
      const guard = createInjectionGuard(
        {
          tools: ['fetch_content'],
          // Calls the sink and does NOT catch what it throws.
          screen: {
            run: async ({ onCall }) => {
              onCall?.(record())
              return injected
            },
          },
        },
        (e) => {
          if (throwing && e.type === 'model_call') throw new Error('recorder is down')
          events.push(e)
        },
        'guard',
      )
      const out = await guard.sanitize('fetch_content', 'a clean page')
      return { out, events }
    }
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})

    const ok = await run(false)
    const broken = await run(true)

    expect(broken.out.summary).toEqual(ok.out.summary)
    expect(broken.out.summary?.screenUnavailable).toBeUndefined()
    expect(broken.out.data).toEqual(ok.out.data)
    expect(broken.events.map((e) => e.type)).not.toContain('content_sanitized')
    expect(modelCalls(broken.events)).toHaveLength(0)
    // Visible, not silent.
    expect(err).toHaveBeenCalledTimes(1)
    expect(String(err.mock.calls[0][0])).toContain('recording the screen call failed')
    err.mockRestore()
  })

  // Mutation: emit `{ ...event, llmCall: call }` unredacted → the page text the
  // screen read rides into the event.
  it('carries none of the content the screen read', async () => {
    const { guard, events } = guardWith(async ({ onCall }) => {
      onCall?.(record())
      return clean
    })
    await guard.sanitize('fetch_content', PAGE_TEXT)

    expect(JSON.stringify(modelCalls(events))).not.toContain(PAGE_TEXT)
  })
})

// ============================================================================
// The summaries, through compactBulkData
// ============================================================================

describe('compactBulkData records the describe calls', () => {
  /** `compactBulkData` reads the run's runtime config, so it runs in a frame. */
  const compact = (...args: Parameters<typeof compactBulkData>) =>
    withRunFrame({}, () => compactBulkData(...args))
  function turnWithResults(n: number) {
    const ctx = createContext('question')
    for (let i = 1; i <= n; i++) {
      ctx.events.push({
        id: `r${i}`,
        type: 'tool_result',
        ts: 1,
        patternId: 'web',
        data: { tool: 'fetch', result: `payload ${i}`, success: true },
      })
    }
    return ctx
  }
  const describeRecord = (fn = 'ResultDescribe') =>
    record({
      functionName: fn,
      clientName: 'SmallQwen',
      metrics: { ...record().metrics!, costEur: 0.0004, noCacheEur: 0.0004 },
    })

  // Mutation: stop passing `recordCall(...)` as the fifth argument of the
  // single-result `describeFn` call → the summary call is never recorded.
  it('records a single summary call with its client and cost', async () => {
    const ctx = turnWithResults(1)
    await compact(ctx, async () => {}, {
      describe: async (_t, _a, _r, _res, onCall) => {
        onCall?.(describeRecord())
        return 'a summary'
      },
      describeBatch: Object.assign(async () => new Map<string, string>(), {}),
    })

    const [call] = modelCalls(ctx.events)
    expect(call.data).toEqual({ role: 'describe', source: 'fetch' })
    expect(call.patternId).toBe('compactBulkData')
    expect(call.llmCall?.clientName).toBe('SmallQwen')
    expect(call.metrics?.costEur).toBe(0.0004)
  })

  // Mutation: stop passing `recordCall(...)` as the second argument of
  // `describeBatchFn` → a batched summary is never recorded.
  it('records a batched summary call once, not once per result', async () => {
    const ctx = turnWithResults(3)
    await compact(ctx, async () => {}, {
      describe: async () => '',
      describeBatch: Object.assign(async (items: { id: string }[], onCall?: CallRecordSink) => {
        onCall?.(describeRecord('ResultDescribeBatch'))
        return new Map(items.map((i) => [i.id, `summary ${i.id}`]))
      }, {}),
    })

    const calls = modelCalls(ctx.events)
    expect(calls).toHaveLength(1)
    expect(calls[0].data).toEqual({ role: 'describe', items: 3 })
    expect(calls[0].llmCall?.functionName).toBe('ResultDescribeBatch')
  })

  it('records a failed batch, and each per-item retry that follows', async () => {
    const ctx = turnWithResults(2)
    await compact(ctx, async () => {}, {
      describe: async (_t, _a, _r, _res, onCall) => {
        onCall?.(describeRecord())
        return 'one by one'
      },
      describeBatch: Object.assign(async (_items: unknown[], onCall?: CallRecordSink) => {
        onCall?.(describeRecord('ResultDescribeBatch'))
        throw new Error('batch failed')
      }, {}),
    })

    expect(modelCalls(ctx.events).map((e) => e.llmCall?.functionName)).toEqual([
      'ResultDescribeBatch',
      'ResultDescribe',
      'ResultDescribe',
    ])
  })

  // Mutation: push the model_call events after `await onPersist()` → they are
  // not in the saved context.
  it('has the events in the context before it is persisted', async () => {
    const ctx = turnWithResults(1)
    let atPersist = 0
    await compact(
      ctx,
      async () => {
        atPersist = modelCalls(ctx.events).length
      },
      {
        describe: async (_t, _a, _r, _res, onCall) => {
          onCall?.(describeRecord())
          return 'a summary'
        },
        describeBatch: Object.assign(async () => new Map<string, string>(), {}),
      },
    )
    expect(atPersist).toBe(1)
  })

  // Mutation: spread `llmCall: call` straight into the event → the result text
  // the summarizer read rides into the conversation.
  it('carries none of what the summarizer read', async () => {
    const ctx = turnWithResults(1)
    await compact(ctx, async () => {}, {
      describe: async (_t, _a, _r, _res, onCall) => {
        onCall?.(describeRecord())
        return 'a summary'
      },
      describeBatch: Object.assign(async () => new Map<string, string>(), {}),
    })
    expect(JSON.stringify(modelCalls(ctx.events))).not.toContain(PAGE_TEXT)
  })
})

// ============================================================================
// The event itself
// ============================================================================

describe('model_call event', () => {
  const screen = (): ContextEvent =>
    createModelCallEvent('guard', { role: 'screen', source: 'web/x' }, record())

  // Mutation: build the event with `createEvent(..., call)` instead of
  // `createEvent(..., redactCall(call))` → every field the call carried survives.
  it('is redacted where it is built, whoever supplied the record', () => {
    const event = screen()
    expect(event.llmCall).toEqual({
      functionName: 'ScreenUntrustedContent',
      variables: {},
      usage: record().usage,
      metrics: record().metrics,
      durationMs: 3600,
      provider: 'openai-generic',
      clientName: 'LargeQwen',
    })
    expect(JSON.stringify(event)).not.toContain(PAGE_TEXT)
  })

  // Mutation: `createModelCallEvent` omits `metrics` → the call is recorded but
  // no fold sees its cost.
  it('reaches the dashboard fold and the panel total with its cost', () => {
    const events = [screen(), screen()]
    const fold = foldEvents(events)
    expect(fold.meteredCalls).toBe(2)
    expect(fold.costEur).toBeCloseTo(0.0036, 10)
    // Time-priced, so the figure is a floor and says so.
    expect(fold.timePricedCalls).toBe(2)

    const totals = foldTokenTotals(events)
    expect(totals.llmCalls).toBe(2)
    expect(totals.costEur).toBeCloseTo(0.0036, 10)
  })

  // Mutation: blank `head` in the `model_call` case of `getEventPreview` → the
  // panel lists the row with no role and nothing it read. A screen call is the
  // injection guard's, so its row leads with the guard (#795).
  it('labels its panel row with the role and what it read', () => {
    expect(getEventPreview('model_call', { role: 'screen', source: 'web/x' })).toBe(
      'injection · screen web/x',
    )
    expect(getEventPreview('model_call', { role: 'describe', items: 3 })).toBe('describe ×3')
    expect(getEventPreview('model_call', { role: 'describe' })).toBe('describe')
  })

  it('is never rendered into an LLM-facing view as more than its label', () => {
    const ctx = createContext('q')
    ctx.events.push(screen())
    const text = createEventView(ctx).fromAll().serialize()
    expect(text).toContain('screen call: web/x')
    expect(text).not.toContain(PAGE_TEXT)
    expect(text).not.toContain('LargeQwen')
  })

  // Mutation: remove 'model_call' from ALWAYS_COMMIT_TYPES → under 'on-success'
  // on a failed turn, or 'never', the spend is dropped with the content events.
  it('is committed under every strategy, so spend survives a failed turn', () => {
    for (const strategy of ['never', 'last', 'on-success'] as const) {
      const ctx = createContext('q')
      if (strategy === 'on-success') ctx.status = 'error'
      const scope = createScope('guard', {})
      scope.events.push(screen())
      commitEvents(ctx, scope, strategy)
      expect(modelCalls(ctx.events), strategy).toHaveLength(1)
    }
  })
})

// ============================================================================
// Boundary timestamps: stamped when the work started, not when it was merged
// ============================================================================

describe('boundary events are stamped at the work, not at the merge', () => {
  const T0 = 1_700_000_000_000

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    __clearReferenceCache()
  })
  afterEach(() => vi.useRealTimers())

  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

  // Mutation: move `createEvent('pattern_enter', …)` back below
  // `await wrappedPattern.fn(…)` → the enter is stamped T0 + 5000, after the
  // events it contains.
  it('withReferences: pattern_enter carries the start time, pattern_exit the end', async () => {
    const inner: ConfiguredPattern<Record<string, unknown>> = {
      name: 'inner',
      config: { patternId: 'inner' },
      fn: async (s) => {
        await wait(5000)
        s.events.push({
          id: 'work',
          type: 'tool_call',
          ts: Date.now(),
          patternId: 'inner',
          data: { tool: 't', args: {} },
        })
        return s
      },
    }
    const wrapped = withReferences(inner, {
      selector: async () => ({ reasoning: '', selected: [] }),
    })
    const ctx = createContext<Record<string, unknown>>('q')
    const scope: PatternScope<Record<string, unknown>> = {
      id: 'wrap',
      data: {},
      events: [],
      startTime: T0,
    }

    const running = wrapped.fn(scope, createEventView(ctx))
    await vi.advanceTimersByTimeAsync(5000)
    const out = await running

    const byType = (t: string) => out.events.find((e) => e.type === t)!
    expect(byType('pattern_enter').ts).toBe(T0)
    expect(byType('pattern_exit').ts).toBe(T0 + 5000)
    // The order the panel sorts into (by `ts`) is the order of the work.
    const sorted = [...out.events].sort((a, b) => a.ts - b.ts).map((e) => e.type)
    expect(sorted.indexOf('pattern_enter')).toBeLessThan(sorted.indexOf('tool_call'))
  })

  // Mutation: drop the `ts: spans[i].start` / `ts: spans[i].end` overrides →
  // every branch boundary is stamped at the merge, T0 + 3000.
  it('parallel: each branch is stamped with its own start and end', async () => {
    const branch = (id: string, ms: number): ConfiguredPattern<Record<string, unknown>> => ({
      name: id,
      config: { patternId: id },
      fn: async (s) => {
        await wait(ms)
        return s
      },
    })
    const par = parallel([branch('fast', 1000), branch('slow', 3000)])
    const ctx = createContext<Record<string, unknown>>('q')
    const scope: PatternScope<Record<string, unknown>> = {
      id: 'par',
      data: {},
      events: [],
      startTime: T0,
    }

    const running = par.fn(scope, createEventView(ctx))
    await vi.advanceTimersByTimeAsync(3000)
    const out = await running

    const at = (type: string, patternId: string) =>
      out.events.find((e) => e.type === type && e.patternId === patternId)!.ts
    expect(at('pattern_enter', 'fast')).toBe(T0)
    expect(at('pattern_enter', 'slow')).toBe(T0)
    expect(at('pattern_exit', 'fast')).toBe(T0 + 1000)
    expect(at('pattern_exit', 'slow')).toBe(T0 + 3000)
  })
})
