/**
 * compactIntent Pattern Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ContextEvent, EventType, UnifiedContext } from '../../../../lib/harness-patterns'

// Mock server-only imports
vi.mock('../../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn()
}))

// Mock BAML client
vi.mock('../../../../../baml_client', () => ({
  b: {
    CompactIntent: vi.fn(async () => 'Locate the Fibonacci script you created earlier under /work.')
  }
}))

// Mock Collector — must be a real class so `new Collector()` works
vi.mock('@boundaryml/baml', () => {
  class MockCollector {
    last = {
      rawLlmResponse: 'Raw response',
      usage: { inputTokens: 40, outputTokens: 12 },
      calls: [{ httpRequest: { body: { messages: [] } }, provider: 'anthropic', clientName: 'DescribeAnthropic' }]
    }
    constructor(_name?: string) {}
  }
  return { Collector: MockCollector }
})

type Ev = { type: EventType; ts: number; patternId: string; data: unknown }

function ctxOf(events: Ev[]): UnifiedContext<Record<string, unknown>> {
  const lastUser = events.filter(e => e.type === 'user_message').slice(-1)[0]
  return {
    sessionId: 'test',
    createdAt: Date.now(),
    events: events as ContextEvent[],
    status: 'running',
    data: {},
    input: lastUser ? (lastUser.data as { content: string }).content : ''
  }
}

const PATTERN_ID = 'compact-intent-test'

async function load() {
  const { compactIntent } = await import('../../../../lib/harness-patterns/patterns/compactIntent.server')
  const { createScope } = await import('../../../../lib/harness-patterns/context.server')
  const { createEventView } = await import('../../../../lib/harness-patterns/patterns')
  const { b } = await import('../../../../../baml_client')
  return { compactIntent, createScope, createEventView, b }
}

describe('compactIntent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('exports a factory that returns a ConfiguredPattern', async () => {
    const { compactIntent } = await load()
    const pattern = compactIntent({ patternId: PATTERN_ID })
    expect(pattern.name).toBe('compactIntent')
    expect(pattern.config.patternId).toBe(PATTERN_ID)
    expect(typeof pattern.fn).toBe('function')
  })

  it('skips the LLM call on turn 1 (no history) and passes the message through', async () => {
    const { compactIntent, createScope, createEventView, b } = await load()
    const now = Date.now()
    const ctx = ctxOf([
      { type: 'user_message', ts: now, patternId: 'harness', data: { content: 'Write a Fibonacci script' } }
    ])
    const pattern = compactIntent({ patternId: PATTERN_ID })
    const scope = createScope(PATTERN_ID, {})
    const view = createEventView(ctx, pattern.config.viewConfig, PATTERN_ID)

    const result = await pattern.fn(scope, view)

    expect(b.CompactIntent).not.toHaveBeenCalled()
    expect((result.data as { intent?: string }).intent).toBe('Write a Fibonacci script')
    const ic = result.events.filter(e => e.type === 'intent_compacted')
    expect(ic).toHaveLength(1)
    expect((ic[0].data as { skipped?: string }).skipped).toBe('no-history')
    expect((ic[0].data as { historyLength: number }).historyLength).toBe(0)
  })

  it('rewrites a back-referencing follow-up into a self-contained brief', async () => {
    const { compactIntent, createScope, createEventView, b } = await load()
    const now = Date.now()
    const ctx = ctxOf([
      { type: 'user_message', ts: now, patternId: 'harness', data: { content: 'Write a Fibonacci script to /work' } },
      { type: 'assistant_message', ts: now + 1, patternId: 'sandbox-session-synth', data: { content: 'Done, computed fib(10).', final: true } },
      { type: 'user_message', ts: now + 2, patternId: 'harness', data: { content: "I can't find the file" } }
    ])
    const pattern = compactIntent({ patternId: PATTERN_ID })
    const scope = createScope(PATTERN_ID, {})
    const view = createEventView(ctx, pattern.config.viewConfig, PATTERN_ID)

    const result = await pattern.fn(scope, view)

    expect(b.CompactIntent).toHaveBeenCalledTimes(1)
    // history (prior messages) is the first arg, latest the second
    const [history, latest] = vi.mocked(b.CompactIntent).mock.calls[0]
    expect(latest).toBe("I can't find the file")
    expect(history.length).toBe(2)
    expect((result.data as { intent?: string }).intent).toBe(
      'Locate the Fibonacci script you created earlier under /work.'
    )
    const ic = result.events.filter(e => e.type === 'intent_compacted')
    expect(ic).toHaveLength(1)
    expect((ic[0].data as { skipped?: string }).skipped).toBeUndefined()
    expect((ic[0].data as { historyLength: number }).historyLength).toBe(2)
    // LLM call observability is attached to the event
    expect(ic[0].llmCall?.functionName).toBe('CompactIntent')
  })

  it('falls back to the raw latest message when the model returns blank', async () => {
    const { compactIntent, createScope, createEventView, b } = await load()
    vi.mocked(b.CompactIntent).mockResolvedValueOnce('   ')
    const now = Date.now()
    const ctx = ctxOf([
      { type: 'user_message', ts: now, patternId: 'harness', data: { content: 'first' } },
      { type: 'user_message', ts: now + 1, patternId: 'harness', data: { content: 'do the thing' } }
    ])
    const pattern = compactIntent({ patternId: PATTERN_ID })
    const scope = createScope(PATTERN_ID, {})
    const view = createEventView(ctx, pattern.config.viewConfig, PATTERN_ID)

    const result = await pattern.fn(scope, view)

    expect((result.data as { intent?: string }).intent).toBe('do the thing')
  })

  it('is backward-safe: leaves intent unset and tracks an error if the BAML call throws', async () => {
    const { compactIntent, createScope, createEventView, b } = await load()
    vi.mocked(b.CompactIntent).mockRejectedValueOnce(new Error('describe model unavailable'))
    const now = Date.now()
    const ctx = ctxOf([
      { type: 'user_message', ts: now, patternId: 'harness', data: { content: 'first' } },
      { type: 'user_message', ts: now + 1, patternId: 'harness', data: { content: 'again please' } }
    ])
    const pattern = compactIntent({ patternId: PATTERN_ID })
    const scope = createScope(PATTERN_ID, {})
    const view = createEventView(ctx, pattern.config.viewConfig, PATTERN_ID)

    const result = await pattern.fn(scope, view)

    expect((result.data as { intent?: string }).intent).toBeUndefined()
    const errors = result.events.filter(e => e.type === 'error')
    expect(errors.length).toBeGreaterThan(0)
    expect(JSON.stringify(errors[0].data)).toContain('describe model unavailable')
  })

  it('does nothing when there is no user message in view', async () => {
    const { compactIntent, createScope, createEventView, b } = await load()
    const ctx = ctxOf([])
    const pattern = compactIntent({ patternId: PATTERN_ID })
    const scope = createScope(PATTERN_ID, {})
    const view = createEventView(ctx, pattern.config.viewConfig, PATTERN_ID)

    const result = await pattern.fn(scope, view)

    expect(b.CompactIntent).not.toHaveBeenCalled()
    expect((result.data as { intent?: string }).intent).toBeUndefined()
    expect(result.events).toHaveLength(0)
  })
})
