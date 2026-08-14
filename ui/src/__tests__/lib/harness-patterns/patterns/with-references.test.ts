/**
 * withReferences Pattern Tests
 *
 * Covers skip optimizations (empty/single/cached), scope filter, maxRefs cap,
 * and that attached refs flow into the inner pattern via scope.data.attachedRefs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ContextEvent, PatternScope, ToolResultEventData, ConfiguredPattern } from '../../../../lib/harness-patterns/types'

// Mock server-only imports
vi.mock('../../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn()
}))

// Mock the BAML client — selector returns whatever the test sets up
const mockReferenceSelector = vi.fn()
vi.mock('../../../../../baml_client', () => ({
  b: {
    ReferenceSelector: (...args: unknown[]) => mockReferenceSelector(...args)
  }
}))

// ----------------------------------------------------------------------------
// Helpers — build minimal events / scopes for unit tests
// ----------------------------------------------------------------------------

function toolResultEvent(opts: {
  id: string
  patternId: string
  tool: string
  result: unknown
  summary?: string
  ts?: number
  hidden?: boolean
  archived?: boolean
  success?: boolean
}): ContextEvent {
  return {
    id: opts.id,
    type: 'tool_result',
    ts: opts.ts ?? Date.now(),
    patternId: opts.patternId,
    data: {
      tool: opts.tool,
      result: opts.result,
      success: opts.success ?? true,
      summary: opts.summary,
      hidden: opts.hidden,
      archived: opts.archived
    } satisfies ToolResultEventData
  }
}


function makeInnerPattern(name = 'inner'): { pattern: ConfiguredPattern<Record<string, unknown>>; fn: ReturnType<typeof vi.fn> } {
  const fn = vi.fn(async (scope: PatternScope<Record<string, unknown>>) => scope)
  return {
    pattern: { name, fn, config: { patternId: name } },
    fn
  }
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

describe('withReferences', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    const { __clearReferenceCache } = await import('../../../../lib/harness-patterns/patterns/with-references.server')
    __clearReferenceCache()
  })

  it('exports withReferences', async () => {
    const { withReferences } = await import('../../../../lib/harness-patterns/patterns/with-references.server')
    expect(typeof withReferences).toBe('function')
  })

  it('skipped="empty" when there are no eligible tool_result events', async () => {
    const { withReferences } = await import('../../../../lib/harness-patterns/patterns/with-references.server')
    const { createContext } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

    const ctx = createContext<Record<string, unknown>>('do something')
    const view = createEventView(ctx)
    const inner = makeInnerPattern()
    const wrapped = withReferences(inner.pattern, { trackHistory: 'reference_attached' })

    const scope: PatternScope<Record<string, unknown>> = {
      id: 'wrap-1', data: {}, events: [], startTime: Date.now()
    }
    const result = await wrapped.fn(scope, view)

    const refEvent = result.events.find(e => e.type === 'reference_attached')
    expect(refEvent).toBeDefined()
    expect((refEvent!.data as { skipped?: string }).skipped).toBe('empty')
    expect(mockReferenceSelector).not.toHaveBeenCalled()
    expect(scope.data.attachedRefs).toEqual([])
    expect(inner.fn).toHaveBeenCalled()
  })

  it('skipped="single" attaches the sole candidate without calling selector', async () => {
    const { withReferences } = await import('../../../../lib/harness-patterns/patterns/with-references.server')
    const { createContext } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

    const ctx = createContext<Record<string, unknown>>('test')
    ctx.events.push(toolResultEvent({
      id: 'ev-only',
      patternId: 'web-search',
      tool: 'fetch',
      result: 'page contents',
      summary: 'a web page'
    }))
    const view = createEventView(ctx)
    const inner = makeInnerPattern()
    const wrapped = withReferences(inner.pattern, { trackHistory: 'reference_attached' })

    const scope: PatternScope<Record<string, unknown>> = {
      id: 'wrap-1', data: {}, events: [], startTime: Date.now()
    }
    await wrapped.fn(scope, view)

    const refEvent = scope.events.find(e => e.type === 'reference_attached')
    expect((refEvent!.data as { skipped?: string }).skipped).toBe('single')
    expect(mockReferenceSelector).not.toHaveBeenCalled()
    const attached = scope.data.attachedRefs as Array<{ ref_id: string }>
    expect(attached.map(r => r.ref_id)).toEqual(['ev-only'])
  })

  it('calls selector when there are multiple candidates and respects maxRefs', async () => {
    const { withReferences } = await import('../../../../lib/harness-patterns/patterns/with-references.server')
    const { createContext } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

    const ctx = createContext<Record<string, unknown>>('explain postgres 18')
    for (let i = 0; i < 4; i++) {
      ctx.events.push(toolResultEvent({
        id: `ev-${i}`, patternId: 'web-search', tool: 'fetch',
        result: `result ${i}`, summary: `summary ${i}`, ts: Date.now() - i * 1000
      }))
    }
    const view = createEventView(ctx)
    const inner = makeInnerPattern()
    const wrapped = withReferences(inner.pattern, { maxRefs: 2, trackHistory: 'reference_attached' })

    mockReferenceSelector.mockResolvedValue({
      reasoning: 'all relevant',
      selected: [
        { ref_id: 'ev-0', reason: 'most recent' },
        { ref_id: 'ev-1', reason: 'second most recent' },
        { ref_id: 'ev-2', reason: 'third most recent' }
      ]
    })

    const scope: PatternScope<Record<string, unknown>> = {
      id: 'wrap-1', data: {}, events: [], startTime: Date.now()
    }
    await wrapped.fn(scope, view)

    expect(mockReferenceSelector).toHaveBeenCalledOnce()
    const attached = scope.data.attachedRefs as Array<{ ref_id: string }>
    expect(attached.map(r => r.ref_id)).toEqual(['ev-0', 'ev-1'])
  })

  it('cache hit reuses the prior decision without re-calling selector', async () => {
    const { withReferences } = await import('../../../../lib/harness-patterns/patterns/with-references.server')
    const { createContext } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

    const ctx = createContext<Record<string, unknown>>('explain postgres 18')
    ctx.events.push(toolResultEvent({ id: 'ev-a', patternId: 'web-search', tool: 'fetch', result: 'A', summary: 'a' }))
    ctx.events.push(toolResultEvent({ id: 'ev-b', patternId: 'web-search', tool: 'fetch', result: 'B', summary: 'b' }))
    const view = createEventView(ctx)
    const inner = makeInnerPattern()
    const wrapped = withReferences(inner.pattern, { trackHistory: 'reference_attached' })

    mockReferenceSelector.mockResolvedValue({
      reasoning: 'pick a',
      selected: [{ ref_id: 'ev-a', reason: 'most relevant' }]
    })

    // First call — selector runs
    const scope1: PatternScope<Record<string, unknown>> = { id: 'wrap', data: {}, events: [], startTime: Date.now() }
    await wrapped.fn(scope1, view)
    expect(mockReferenceSelector).toHaveBeenCalledTimes(1)

    // Second call with same intent + same candidates — cache hit
    const scope2: PatternScope<Record<string, unknown>> = { id: 'wrap', data: {}, events: [], startTime: Date.now() }
    await wrapped.fn(scope2, view)
    expect(mockReferenceSelector).toHaveBeenCalledTimes(1)

    const refEvent = scope2.events.find(e => e.type === 'reference_attached')
    expect((refEvent!.data as { skipped?: string }).skipped).toBe('cached')
    expect((scope2.data.attachedRefs as Array<{ ref_id: string }>).map(r => r.ref_id)).toEqual(['ev-a'])
  })

  it('scope=self filters candidates to the wrapper\'s patternId', async () => {
    const { withReferences } = await import('../../../../lib/harness-patterns/patterns/with-references.server')
    const { createContext } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

    const ctx = createContext<Record<string, unknown>>('test')
    ctx.events.push(toolResultEvent({ id: 'ev-web', patternId: 'web-search', tool: 'fetch', result: 'W', summary: 'w' }))
    ctx.events.push(toolResultEvent({ id: 'ev-self-1', patternId: 'wrap-1', tool: 'lookup', result: 'S1', summary: 's1' }))
    ctx.events.push(toolResultEvent({ id: 'ev-self-2', patternId: 'wrap-1', tool: 'lookup', result: 'S2', summary: 's2' }))
    const view = createEventView(ctx)
    const inner = makeInnerPattern()
    const wrapped = withReferences(inner.pattern, { scope: 'self', trackHistory: 'reference_attached' })

    mockReferenceSelector.mockResolvedValue({
      reasoning: 'both relevant',
      selected: [
        { ref_id: 'ev-self-1', reason: 'first' },
        { ref_id: 'ev-self-2', reason: 'second' }
      ]
    })

    const scope: PatternScope<Record<string, unknown>> = { id: 'wrap-1', data: {}, events: [], startTime: Date.now() }
    await wrapped.fn(scope, view)

    const refEvent = scope.events.find(e => e.type === 'reference_attached')
    const candidates = (refEvent!.data as { candidates: Array<{ ref_id: string }> }).candidates
    expect(candidates.map(c => c.ref_id).sort()).toEqual(['ev-self-1', 'ev-self-2'])
    // Web-search ref must NOT appear in the candidate set offered to the selector
    expect(candidates.map(c => c.ref_id)).not.toContain('ev-web')
  })

  it('excludes hidden, archived, and failed tool_results from candidates', async () => {
    const { withReferences } = await import('../../../../lib/harness-patterns/patterns/with-references.server')
    const { createContext } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

    const ctx = createContext<Record<string, unknown>>('test')
    ctx.events.push(toolResultEvent({ id: 'ev-good', patternId: 'p', tool: 'x', result: 'G', summary: 'good' }))
    ctx.events.push(toolResultEvent({ id: 'ev-hidden', patternId: 'p', tool: 'x', result: 'H', summary: 'h', hidden: true }))
    ctx.events.push(toolResultEvent({ id: 'ev-archived', patternId: 'p', tool: 'x', result: 'A', summary: 'a', archived: true }))
    ctx.events.push(toolResultEvent({ id: 'ev-failed', patternId: 'p', tool: 'x', result: 'F', summary: 'f', success: false }))
    const view = createEventView(ctx)
    const inner = makeInnerPattern()
    const wrapped = withReferences(inner.pattern, { trackHistory: 'reference_attached' })

    const scope: PatternScope<Record<string, unknown>> = { id: 'wrap', data: {}, events: [], startTime: Date.now() }
    await wrapped.fn(scope, view)

    const refEvent = scope.events.find(e => e.type === 'reference_attached')
    expect((refEvent!.data as { skipped?: string }).skipped).toBe('single')
    const attached = scope.data.attachedRefs as Array<{ ref_id: string }>
    expect(attached.map(r => r.ref_id)).toEqual(['ev-good'])
  })

  it('uses scope.data.intent when present (router-set), falls back to last user_message', async () => {
    const { withReferences } = await import('../../../../lib/harness-patterns/patterns/with-references.server')
    const { createContext } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

    const ctx = createContext<Record<string, unknown>>('plain user input')
    ctx.events.push(toolResultEvent({ id: 'ev-1', patternId: 'p', tool: 'x', result: '1', summary: 's1' }))
    ctx.events.push(toolResultEvent({ id: 'ev-2', patternId: 'p', tool: 'x', result: '2', summary: 's2' }))
    const view = createEventView(ctx)
    const inner = makeInnerPattern()
    const wrapped = withReferences(inner.pattern, { trackHistory: 'reference_attached' })

    mockReferenceSelector.mockResolvedValue({ reasoning: '', selected: [] })

    const scope: PatternScope<Record<string, unknown>> = {
      id: 'wrap',
      data: { intent: 'router-classified intent' },
      events: [],
      startTime: Date.now()
    }
    await wrapped.fn(scope, view)

    const callArgs = mockReferenceSelector.mock.calls[0]
    expect(callArgs[0]).toBe('router-classified intent')
  })
})
