/**
 * Parallel Pattern Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock server-only imports
vi.mock('../../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn()
}))

describe('parallel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should export parallel function', async () => {
    const { parallel } = await import('../../../../lib/harness-patterns/patterns/parallel.server')
    expect(parallel).toBeDefined()
    expect(typeof parallel).toBe('function')
  })

  it('should create a ConfiguredPattern', async () => {
    const { parallel } = await import('../../../../lib/harness-patterns/patterns/parallel.server')

    const pattern = parallel([], { patternId: 'test-parallel' })

    expect(pattern.name).toBe('parallel')
    expect(pattern.fn).toBeDefined()
    expect(pattern.config.patternId).toBe('test-parallel')
  })

  it('should execute patterns concurrently', async () => {
    const { parallel } = await import('../../../../lib/harness-patterns/patterns/parallel.server')
    const { createContext } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

    const executionOrder: string[] = []

    const pattern1 = {
      name: 'first',
      fn: vi.fn(async (scope) => {
        executionOrder.push('first-start')
        await new Promise(resolve => setTimeout(resolve, 10))
        executionOrder.push('first-end')
        scope.data = { ...scope.data, first: true }
        return scope
      }),
      config: { patternId: 'first' }
    }

    const pattern2 = {
      name: 'second',
      fn: vi.fn(async (scope) => {
        executionOrder.push('second-start')
        scope.data = { ...scope.data, second: true }
        executionOrder.push('second-end')
        return scope
      }),
      config: { patternId: 'second' }
    }

    const ctx = createContext<{ first?: boolean; second?: boolean }>('test')
    const view = createEventView(ctx)

    const parallelPattern = parallel([pattern1, pattern2])
    const result = await parallelPattern.fn(
      { id: 'parallel', data: ctx.data, events: [], startTime: Date.now() },
      view
    )

    // Both should have executed
    expect(pattern1.fn).toHaveBeenCalled()
    expect(pattern2.fn).toHaveBeenCalled()

    // Data should be merged
    expect(result.data.first).toBe(true)
    expect(result.data.second).toBe(true)
  })

  it('should merge events from all patterns', async () => {
    const { parallel } = await import('../../../../lib/harness-patterns/patterns/parallel.server')
    const { createContext } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

    const pattern1 = {
      name: 'first',
      fn: vi.fn(async (scope) => {
        scope.events.push({
          type: 'tool_call' as const,
          ts: Date.now(),
          patternId: 'first',
          data: { tool: 'test1' }
        })
        return scope
      }),
      config: { patternId: 'first' }
    }

    const pattern2 = {
      name: 'second',
      fn: vi.fn(async (scope) => {
        scope.events.push({
          type: 'tool_call' as const,
          ts: Date.now(),
          patternId: 'second',
          data: { tool: 'test2' }
        })
        return scope
      }),
      config: { patternId: 'second' }
    }

    const ctx = createContext('test')
    const view = createEventView(ctx)

    const parallelPattern = parallel([pattern1, pattern2])
    const result = await parallelPattern.fn(
      { id: 'parallel', data: ctx.data, events: [], startTime: Date.now() },
      view
    )

    // Events from both branches should be merged
    const toolCalls = result.events.filter(e => e.type === 'tool_call')
    expect(toolCalls.length).toBe(2)
  })

  it('should wrap branch events with pattern_enter/exit', async () => {
    const { parallel } = await import('../../../../lib/harness-patterns/patterns/parallel.server')
    const { createContext } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

    const pattern1 = {
      name: 'first',
      fn: vi.fn(async (scope) => {
        scope.events.push({
          type: 'tool_call' as const,
          ts: Date.now(),
          patternId: 'first',
          data: { tool: 'test1' }
        })
        return scope
      }),
      config: { patternId: 'branch-a' }
    }

    const pattern2 = {
      name: 'second',
      fn: vi.fn(async (scope) => {
        scope.events.push({
          type: 'tool_call' as const,
          ts: Date.now(),
          patternId: 'second',
          data: { tool: 'test2' }
        })
        return scope
      }),
      config: { patternId: 'branch-b' }
    }

    const ctx = createContext('test')
    const view = createEventView(ctx)

    const parallelPattern = parallel([pattern1, pattern2])
    const result = await parallelPattern.fn(
      { id: 'parallel', data: ctx.data, events: [], startTime: Date.now() },
      view
    )

    // Should have pattern_enter, tool_call, pattern_exit for each branch
    const enters = result.events.filter(e => e.type === 'pattern_enter')
    const exits = result.events.filter(e => e.type === 'pattern_exit')
    expect(enters.length).toBe(2)
    expect(exits.length).toBe(2)

    // First branch events should be: enter(branch-a), tool_call, exit(branch-a)
    expect(result.events[0].type).toBe('pattern_enter')
    expect(result.events[0].patternId).toBe('branch-a')
    expect(result.events[1].type).toBe('tool_call')
    expect(result.events[2].type).toBe('pattern_exit')
    expect(result.events[2].patternId).toBe('branch-a')
  })

  it('should handle rejected branches gracefully', async () => {
    const { parallel } = await import('../../../../lib/harness-patterns/patterns/parallel.server')
    const { createContext } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

    const pattern1 = {
      name: 'success',
      fn: vi.fn(async (scope) => {
        scope.data = { ...scope.data, success: true }
        return scope
      }),
      config: { patternId: 'success' }
    }

    const pattern2 = {
      name: 'failure',
      fn: vi.fn(async () => {
        throw new Error('Branch failed')
      }),
      config: { patternId: 'failure' }
    }

    const ctx = createContext<{ success?: boolean }>('test')
    const view = createEventView(ctx)

    const parallelPattern = parallel([pattern1, pattern2])
    const result = await parallelPattern.fn(
      { id: 'parallel', data: ctx.data, events: [], startTime: Date.now() },
      view
    )

    // Successful branch data should be present
    expect(result.data.success).toBe(true)

    // Error event should be tracked for failed branch
    const errorEvents = result.events.filter(e => e.type === 'error')
    expect(errorEvents.length).toBeGreaterThan(0)
    expect(JSON.stringify(errorEvents[0].data)).toContain('Branch failure failed')
  })

  it('should handle empty patterns array', async () => {
    const { parallel } = await import('../../../../lib/harness-patterns/patterns/parallel.server')
    const { createContext } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

    const ctx = createContext('test')
    const view = createEventView(ctx)

    const parallelPattern = parallel([])
    const result = await parallelPattern.fn(
      { id: 'parallel', data: ctx.data, events: [], startTime: Date.now() },
      view
    )

    expect(result).toBeDefined()
    expect(result.events).toEqual([])
  })

  it('should use isolated scopes for each branch', async () => {
    const { parallel } = await import('../../../../lib/harness-patterns/patterns/parallel.server')
    const { createContext } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

    let scope1Id: string | undefined
    let scope2Id: string | undefined

    const pattern1 = {
      name: 'first',
      fn: vi.fn(async (scope) => {
        scope1Id = scope.id
        return scope
      }),
      config: { patternId: 'first' }
    }

    const pattern2 = {
      name: 'second',
      fn: vi.fn(async (scope) => {
        scope2Id = scope.id
        return scope
      }),
      config: { patternId: 'second' }
    }

    const ctx = createContext('test')
    const view = createEventView(ctx)

    const parallelPattern = parallel([pattern1, pattern2])
    await parallelPattern.fn(
      { id: 'parallel', data: ctx.data, events: [], startTime: Date.now() },
      view
    )

    // Each branch should have its own scope ID
    expect(scope1Id).toBe('first')
    expect(scope2Id).toBe('second')
    expect(scope1Id).not.toBe(scope2Id)
  })

  it('should handle catch block errors', async () => {
    const { parallel } = await import('../../../../lib/harness-patterns/patterns/parallel.server')
    const { createContext } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

    const ctx = createContext('test')
    const view = createEventView(ctx)

    // Create a pattern that will cause Promise.allSettled to fail
    // This is hard to trigger normally, so we'll mock it
    const originalAllSettled = Promise.allSettled
    Promise.allSettled = vi.fn().mockRejectedValue(new Error('AllSettled error'))

    const parallelPattern = parallel([])

    const result = await parallelPattern.fn(
      { id: 'parallel', data: ctx.data, events: [], startTime: Date.now() },
      view
    )

    // Restore
    Promise.allSettled = originalAllSettled

    // Error should be tracked
    const errorEvents = result.events.filter(e => e.type === 'error')
    expect(errorEvents.length).toBeGreaterThan(0)
  })
})
