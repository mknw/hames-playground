/**
 * Context Tests
 *
 * Tests for UnifiedContext creation and manipulation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock server-only imports
vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn()
}))

describe('context', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('createContext', () => {
    it('should create a context with default values', async () => {
      const { createContext } = await import('../../../lib/harness-patterns/context.server')

      const ctx = createContext('test message')

      expect(ctx.sessionId).toBeDefined()
      expect(ctx.sessionId).toMatch(/^session-/)
      expect(ctx.createdAt).toBeDefined()
      expect(ctx.status).toBe('running')
      expect(ctx.input).toBe('test message')
      expect(ctx.events).toHaveLength(1)
      expect(ctx.events[0].type).toBe('user_message')
    })

    it('should accept custom session ID', async () => {
      const { createContext } = await import('../../../lib/harness-patterns/context.server')

      const ctx = createContext('test', {}, 'custom-session-id')

      expect(ctx.sessionId).toBe('custom-session-id')
    })

    it('should accept initial data', async () => {
      const { createContext } = await import('../../../lib/harness-patterns/context.server')

      const ctx = createContext('test', { foo: 'bar' })

      expect(ctx.data).toEqual({ foo: 'bar' })
    })
  })

  describe('createScope', () => {
    it('should create an isolated pattern scope', async () => {
      const { createScope } = await import('../../../lib/harness-patterns/context.server')

      const scope = createScope('test-pattern', { value: 42 })

      expect(scope.id).toBe('test-pattern')
      expect(scope.data).toEqual({ value: 42 })
      expect(scope.events).toEqual([])
      expect(scope.startTime).toBeDefined()
    })
  })

  describe('createEvent', () => {
    it('should create an event with timestamp', async () => {
      const { createEvent } = await import('../../../lib/harness-patterns/context.server')

      const event = createEvent('tool_call', 'pattern-1', { tool: 'test' })

      expect(event.type).toBe('tool_call')
      expect(event.patternId).toBe('pattern-1')
      expect(event.data).toEqual({ tool: 'test' })
      expect(event.ts).toBeDefined()
    })

    it('should include llmCall data when provided', async () => {
      const { createEvent } = await import('../../../lib/harness-patterns/context.server')

      const llmCall = {
        functionName: 'LoopController',
        variables: { message: 'test' },
        durationMs: 100
      }

      const event = createEvent('controller_action', 'pattern-1', {}, llmCall)

      expect(event.llmCall).toEqual(llmCall)
    })
  })

  describe('shouldTrack', () => {
    it('should return true when trackHistory is true', async () => {
      const { shouldTrack } = await import('../../../lib/harness-patterns/context.server')

      expect(shouldTrack('tool_call', true)).toBe(true)
      expect(shouldTrack('tool_result', true)).toBe(true)
    })

    it('should return false when trackHistory is false', async () => {
      const { shouldTrack } = await import('../../../lib/harness-patterns/context.server')

      expect(shouldTrack('tool_call', false)).toBe(false)
    })

    it('should match single event type', async () => {
      const { shouldTrack } = await import('../../../lib/harness-patterns/context.server')

      expect(shouldTrack('tool_call', 'tool_call')).toBe(true)
      expect(shouldTrack('tool_result', 'tool_call')).toBe(false)
    })

    it('should match array of event types', async () => {
      const { shouldTrack } = await import('../../../lib/harness-patterns/context.server')

      expect(shouldTrack('tool_call', ['tool_call', 'tool_result'])).toBe(true)
      expect(shouldTrack('tool_result', ['tool_call', 'tool_result'])).toBe(true)
      expect(shouldTrack('error', ['tool_call', 'tool_result'])).toBe(false)
    })
  })

  describe('trackEvent', () => {
    it('should add event to scope when should track', async () => {
      const { trackEvent, createScope } = await import('../../../lib/harness-patterns/context.server')

      const scope = createScope('test', {})
      trackEvent(scope, 'tool_call', { tool: 'test' }, true)

      expect(scope.events).toHaveLength(1)
      expect(scope.events[0].type).toBe('tool_call')
    })

    it('should not add event when should not track', async () => {
      const { trackEvent, createScope } = await import('../../../lib/harness-patterns/context.server')

      const scope = createScope('test', {})
      trackEvent(scope, 'tool_call', { tool: 'test' }, false)

      expect(scope.events).toHaveLength(0)
    })

    it('should include llmCall in tracked event', async () => {
      const { trackEvent, createScope } = await import('../../../lib/harness-patterns/context.server')

      const scope = createScope('test', {})
      const llmCall = {
        functionName: 'LoopController',
        variables: {},
        usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0, totalTokens: 150 }
      }

      trackEvent(scope, 'controller_action', { action: {} }, true, llmCall)

      expect(scope.events).toHaveLength(1)
      expect(scope.events[0].llmCall).toEqual(llmCall)
    })
  })

  describe('commitEvents', () => {
    it('should commit all events with "always" strategy', async () => {
      const { commitEvents, createContext, createScope } = await import('../../../lib/harness-patterns/context.server')

      const ctx = createContext('test')
      const initialEventCount = ctx.events.length

      const scope = createScope('pattern', {})
      scope.events.push(
        { type: 'tool_call', ts: Date.now(), patternId: 'pattern', data: {} },
        { type: 'tool_result', ts: Date.now(), patternId: 'pattern', data: {} }
      )

      commitEvents(ctx, scope, 'always')

      expect(ctx.events.length).toBe(initialEventCount + 2)
    })

    it('should commit events on success with "on-success" strategy', async () => {
      const { commitEvents, createContext, createScope } = await import('../../../lib/harness-patterns/context.server')

      const ctx = createContext('test')
      ctx.status = 'done'
      const initialEventCount = ctx.events.length

      const scope = createScope('pattern', {})
      scope.events.push({ type: 'tool_call', ts: Date.now(), patternId: 'pattern', data: {} })

      commitEvents(ctx, scope, 'on-success')

      expect(ctx.events.length).toBe(initialEventCount + 1)
    })

    it('should not commit events on error with "on-success" strategy', async () => {
      const { commitEvents, createContext, createScope } = await import('../../../lib/harness-patterns/context.server')

      const ctx = createContext('test')
      ctx.status = 'error'
      const initialEventCount = ctx.events.length

      const scope = createScope('pattern', {})
      scope.events.push({ type: 'tool_call', ts: Date.now(), patternId: 'pattern', data: {} })

      commitEvents(ctx, scope, 'on-success')

      expect(ctx.events.length).toBe(initialEventCount)
    })

    it('should commit only last event with "last" strategy', async () => {
      const { commitEvents, createContext, createScope } = await import('../../../lib/harness-patterns/context.server')

      const ctx = createContext('test')
      const initialEventCount = ctx.events.length

      const scope = createScope('pattern', {})
      scope.events.push(
        { type: 'tool_call', ts: Date.now(), patternId: 'pattern', data: { n: 1 } },
        { type: 'tool_result', ts: Date.now(), patternId: 'pattern', data: { n: 2 } }
      )

      commitEvents(ctx, scope, 'last')

      expect(ctx.events.length).toBe(initialEventCount + 1)
      expect((ctx.events[ctx.events.length - 1].data as { n: number }).n).toBe(2)
    })

    it('should not commit content events with "never" strategy but still commit lifecycle', async () => {
      const { commitEvents, createContext, createScope } = await import('../../../lib/harness-patterns/context.server')

      const ctx = createContext('test')
      const initialEventCount = ctx.events.length

      const scope = createScope('pattern', {})
      scope.events.push(
        { type: 'pattern_enter', ts: Date.now(), patternId: 'child', data: { pattern: 'simpleLoop' } },
        { type: 'tool_call', ts: Date.now(), patternId: 'child', data: {} },
        { type: 'pattern_exit', ts: Date.now(), patternId: 'child', data: { status: 'completed' } }
      )

      commitEvents(ctx, scope, 'never')

      // Only lifecycle events (pattern_enter + pattern_exit) should be committed
      expect(ctx.events.length).toBe(initialEventCount + 2)
      expect(ctx.events[initialEventCount].type).toBe('pattern_enter')
      expect(ctx.events[initialEventCount + 1].type).toBe('pattern_exit')
    })

    it('should always commit lifecycle events regardless of strategy', async () => {
      const { commitEvents, createContext, createScope } = await import('../../../lib/harness-patterns/context.server')

      const ctx = createContext('test')
      const initialEventCount = ctx.events.length

      const scope = createScope('pattern', {})
      scope.events.push(
        { type: 'pattern_enter', ts: Date.now(), patternId: 'sub', data: { pattern: 'loop' } },
        { type: 'tool_call', ts: Date.now(), patternId: 'sub', data: { n: 1 } },
        { type: 'tool_result', ts: Date.now(), patternId: 'sub', data: { n: 2 } },
        { type: 'pattern_exit', ts: Date.now(), patternId: 'sub', data: { status: 'completed' } }
      )

      commitEvents(ctx, scope, 'last')

      // Lifecycle (2) + last content event (1) = 3
      expect(ctx.events.length).toBe(initialEventCount + 3)
      const newEvents = ctx.events.slice(initialEventCount)
      expect(newEvents.filter(e => e.type === 'pattern_enter')).toHaveLength(1)
      expect(newEvents.filter(e => e.type === 'pattern_exit')).toHaveLength(1)
      expect(newEvents.filter(e => e.type === 'tool_result')).toHaveLength(1)
    })
  })

  describe('serialization', () => {
    it('should serialize and deserialize context', async () => {
      const { createContext, serializeContext, deserializeContext } = await import('../../../lib/harness-patterns/context.server')

      const ctx = createContext('test message', { foo: 'bar' })
      const serialized = serializeContext(ctx)
      const deserialized = deserializeContext(serialized)

      expect(deserialized.sessionId).toBe(ctx.sessionId)
      expect(deserialized.input).toBe(ctx.input)
      expect(deserialized.data).toEqual(ctx.data)
      expect(deserialized.events.length).toBe(ctx.events.length)
    })

    it('should preserve hidden/archived/summary fields through round-trip', async () => {
      const { createContext, serializeContext, deserializeContext, enrichToolResult } = await import('../../../lib/harness-patterns/context.server')

      const ctx = createContext('test message')
      ctx.events.push({
        type: 'tool_result',
        ts: Date.now(),
        patternId: 'p1',
        id: 'ev-roundtrip',
        data: { tool: 'search', result: 'data', success: true }
      })

      // Enrich with Data Stash fields
      enrichToolResult(ctx, 'ev-roundtrip', {
        summary: 'Found search results',
        hidden: true
      })

      // Serialize and deserialize
      const serialized = serializeContext(ctx)
      const deserialized = deserializeContext(serialized)

      const event = deserialized.events.find(e => e.id === 'ev-roundtrip')
      expect(event).toBeDefined()
      const data = event!.data as { summary?: string; hidden?: boolean; archived?: boolean }
      expect(data.summary).toBe('Found search results')
      expect(data.hidden).toBe(true)
      expect(data.archived).toBeUndefined()
    })

    it('should preserve archived state through round-trip', async () => {
      const { createContext, serializeContext, deserializeContext, enrichToolResult } = await import('../../../lib/harness-patterns/context.server')

      const ctx = createContext('test')
      ctx.events.push({
        type: 'tool_result',
        ts: Date.now(),
        patternId: 'p1',
        id: 'ev-archived-rt',
        data: { tool: 'fetch', result: 'page', success: true }
      })

      enrichToolResult(ctx, 'ev-archived-rt', { archived: true, summary: 'Fetched page content' })

      const deserialized = deserializeContext(serializeContext(ctx))
      const event = deserialized.events.find(e => e.id === 'ev-archived-rt')
      const data = event!.data as { archived?: boolean; summary?: string }
      expect(data.archived).toBe(true)
      expect(data.summary).toBe('Fetched page content')
    })
  })

  describe('enrichToolResult', () => {
    it('should add summary to a tool_result event', async () => {
      const { createContext, enrichToolResult } = await import('../../../lib/harness-patterns/context.server')

      const ctx = createContext('test')
      ctx.events.push({
        type: 'tool_result',
        ts: Date.now(),
        patternId: 'p1',
        id: 'ev-abc123',
        data: { tool: 'read_neo4j_cypher', result: { nodes: [] }, success: true }
      })

      const found = enrichToolResult(ctx, 'ev-abc123', { summary: 'Found 0 nodes in the graph.' })

      expect(found).toBe(true)
      const data = ctx.events[ctx.events.length - 1].data as { summary?: string }
      expect(data.summary).toBe('Found 0 nodes in the graph.')
    })

    it('should set hidden flag on a tool_result event', async () => {
      const { createContext, enrichToolResult } = await import('../../../lib/harness-patterns/context.server')

      const ctx = createContext('test')
      ctx.events.push({
        type: 'tool_result',
        ts: Date.now(),
        patternId: 'p1',
        id: 'ev-def456',
        data: { tool: 'search', result: 'data', success: true }
      })

      const found = enrichToolResult(ctx, 'ev-def456', { hidden: true })

      expect(found).toBe(true)
      const data = ctx.events[ctx.events.length - 1].data as { hidden?: boolean }
      expect(data.hidden).toBe(true)
    })

    it('should set archived flag on a tool_result event', async () => {
      const { createContext, enrichToolResult } = await import('../../../lib/harness-patterns/context.server')

      const ctx = createContext('test')
      ctx.events.push({
        type: 'tool_result',
        ts: Date.now(),
        patternId: 'p1',
        id: 'ev-ghi789',
        data: { tool: 'fetch', result: 'page content', success: true }
      })

      const found = enrichToolResult(ctx, 'ev-ghi789', { archived: true })

      expect(found).toBe(true)
      const data = ctx.events[ctx.events.length - 1].data as { archived?: boolean }
      expect(data.archived).toBe(true)
    })

    it('should apply multiple fields at once', async () => {
      const { createContext, enrichToolResult } = await import('../../../lib/harness-patterns/context.server')

      const ctx = createContext('test')
      ctx.events.push({
        type: 'tool_result',
        ts: Date.now(),
        patternId: 'p1',
        id: 'ev-multi',
        data: { tool: 'search', result: 'data', success: true }
      })

      enrichToolResult(ctx, 'ev-multi', { summary: 'Found data', hidden: true })

      const data = ctx.events[ctx.events.length - 1].data as { summary?: string; hidden?: boolean }
      expect(data.summary).toBe('Found data')
      expect(data.hidden).toBe(true)
    })

    it('should return false when event not found', async () => {
      const { createContext, enrichToolResult } = await import('../../../lib/harness-patterns/context.server')

      const ctx = createContext('test')

      const found = enrichToolResult(ctx, 'ev-nonexistent', { summary: 'test' })

      expect(found).toBe(false)
    })

    it('should not modify non-tool_result events with matching id', async () => {
      const { createContext, enrichToolResult } = await import('../../../lib/harness-patterns/context.server')

      const ctx = createContext('test')
      ctx.events.push({
        type: 'tool_call',
        ts: Date.now(),
        patternId: 'p1',
        id: 'ev-toolcall',
        data: { tool: 'search', args: {} }
      })

      const found = enrichToolResult(ctx, 'ev-toolcall', { summary: 'should not apply' })

      expect(found).toBe(false)
    })

    it('should mutate event in-place (not clone)', async () => {
      const { createContext, enrichToolResult } = await import('../../../lib/harness-patterns/context.server')

      const ctx = createContext('test')
      const eventData = { tool: 'search', result: 'data', success: true }
      ctx.events.push({
        type: 'tool_result',
        ts: Date.now(),
        patternId: 'p1',
        id: 'ev-inplace',
        data: eventData
      })

      enrichToolResult(ctx, 'ev-inplace', { summary: 'mutated' })

      // The original data object reference should be mutated
      expect((eventData as { summary?: string }).summary).toBe('mutated')
    })
  })

  describe('status helpers', () => {
    it('should set error status', async () => {
      const { createContext, setError } = await import('../../../lib/harness-patterns/context.server')

      const ctx = createContext('test')
      setError(ctx, 'Something went wrong')

      expect(ctx.status).toBe('error')
      expect(ctx.error).toBe('Something went wrong')
    })

    it('should set done status', async () => {
      const { createContext, setDone } = await import('../../../lib/harness-patterns/context.server')

      const ctx = createContext('test')
      setDone(ctx)

      expect(ctx.status).toBe('done')
    })

    it('should set paused status', async () => {
      const { createContext, setPaused } = await import('../../../lib/harness-patterns/context.server')

      const ctx = createContext('test')
      setPaused(ctx)

      expect(ctx.status).toBe('paused')
    })
  })
})
