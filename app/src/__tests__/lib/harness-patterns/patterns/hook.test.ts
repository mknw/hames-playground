/**
 * Hook Pattern Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock server-only imports
vi.mock('../../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn()
}))

describe('hook', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should export hook function', async () => {
    const { hook } = await import('../../../../lib/harness-patterns/patterns/hook.server')
    expect(hook).toBeDefined()
    expect(typeof hook).toBe('function')
  })

  it('should create a ConfiguredPattern with trigger name', async () => {
    const { hook } = await import('../../../../lib/harness-patterns/patterns/hook.server')

    const innerPattern = {
      name: 'inner',
      fn: vi.fn(async (scope) => scope),
      config: { patternId: 'inner' }
    }

    const pattern = hook(innerPattern, {
      trigger: 'session_close',
      patternId: 'close-hook'
    })

    expect(pattern.name).toBe('hook:session_close(inner)')
    expect(pattern.fn).toBeDefined()
  })

  it('should execute pattern synchronously when not background', async () => {
    const { hook } = await import('../../../../lib/harness-patterns/patterns/hook.server')
    const { createContext } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

    const innerFn = vi.fn(async (scope) => {
      scope.events.push({
        type: 'controller_action' as const,
        ts: Date.now(),
        patternId: 'inner',
        data: { action: 'test' }
      })
      scope.data = { ...scope.data, hookRan: true }
      return scope
    })

    const innerPattern = {
      name: 'inner',
      fn: innerFn,
      config: { patternId: 'inner' }
    }

    const ctx = createContext<{ hookRan?: boolean }>('test')
    const view = createEventView(ctx)

    const pattern = hook(innerPattern, { trigger: 'session_close' })
    const result = await pattern.fn(
      { id: 'hook', data: ctx.data, events: [], startTime: Date.now() },
      view
    )

    expect(innerFn).toHaveBeenCalled()
    expect(result.data.hookRan).toBe(true)
    expect(result.events.length).toBeGreaterThan(0)
  })

  it('should merge events from inner pattern', async () => {
    const { hook } = await import('../../../../lib/harness-patterns/patterns/hook.server')
    const { createContext } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

    const innerFn = vi.fn(async (scope) => {
      scope.events.push({
        type: 'tool_call' as const,
        ts: Date.now(),
        patternId: 'inner',
        data: { tool: 'test' }
      })
      return scope
    })

    const innerPattern = {
      name: 'inner',
      fn: innerFn,
      config: { patternId: 'inner' }
    }

    const ctx = createContext('test')
    const view = createEventView(ctx)

    const pattern = hook(innerPattern, { trigger: 'error' })
    const result = await pattern.fn(
      { id: 'hook', data: ctx.data, events: [], startTime: Date.now() },
      view
    )

    const toolCalls = result.events.filter(e => e.type === 'tool_call')
    expect(toolCalls.length).toBeGreaterThanOrEqual(1)
  })

  it('should wrap inner pattern events with pattern_enter/exit', async () => {
    const { hook } = await import('../../../../lib/harness-patterns/patterns/hook.server')
    const { createContext } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

    const innerFn = vi.fn(async (scope) => {
      scope.events.push({
        type: 'tool_call' as const,
        ts: Date.now(),
        patternId: 'inner',
        data: { tool: 'test' }
      })
      return scope
    })

    const innerPattern = {
      name: 'inner',
      fn: innerFn,
      config: { patternId: 'my-inner' }
    }

    const ctx = createContext('test')
    const view = createEventView(ctx)

    const pattern = hook(innerPattern, { trigger: 'session_close' })
    const result = await pattern.fn(
      { id: 'hook', data: ctx.data, events: [], startTime: Date.now() },
      view
    )

    // Should have: pattern_enter, tool_call, pattern_exit
    expect(result.events.length).toBe(3)
    expect(result.events[0].type).toBe('pattern_enter')
    expect(result.events[0].patternId).toBe('my-inner')
    expect(result.events[1].type).toBe('tool_call')
    expect(result.events[2].type).toBe('pattern_exit')
    expect(result.events[2].patternId).toBe('my-inner')
  })

  it('should run pattern in background when background: true', async () => {
    const { hook } = await import('../../../../lib/harness-patterns/patterns/hook.server')
    const { createContext } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

    let hookExecuted = false

    const innerFn = vi.fn(async (scope) => {
      hookExecuted = true
      scope.data = { ...scope.data, hookRan: true }
      return scope
    })

    const innerPattern = {
      name: 'inner',
      fn: innerFn,
      config: { patternId: 'inner' }
    }

    const ctx = createContext<{ hookRan?: boolean }>('test')
    const view = createEventView(ctx)

    const pattern = hook(innerPattern, {
      trigger: 'session_close',
      background: true
    })

    const result = await pattern.fn(
      { id: 'hook', data: ctx.data, events: [], startTime: Date.now() },
      view
    )

    // Should return immediately without waiting for background execution
    expect(result).toBeDefined()

    // Background task should run via queueMicrotask
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(hookExecuted).toBe(true)
  })

  it('should handle errors in background hook without crashing', async () => {
    const { hook } = await import('../../../../lib/harness-patterns/patterns/hook.server')
    const { createContext } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const innerPattern = {
      name: 'inner',
      fn: vi.fn().mockRejectedValue(new Error('Background hook failed')),
      config: { patternId: 'inner' }
    }

    const ctx = createContext('test')
    const view = createEventView(ctx)

    const pattern = hook(innerPattern, {
      trigger: 'session_close',
      background: true
    })

    // Should not throw
    const result = await pattern.fn(
      { id: 'hook', data: ctx.data, events: [], startTime: Date.now() },
      view
    )

    expect(result).toBeDefined()

    // Wait for background task
    await new Promise(resolve => setTimeout(resolve, 10))

    // Should log error
    expect(consoleSpy).toHaveBeenCalled()
    expect(consoleSpy.mock.calls[0][0]).toContain('Hook session_close failed')

    consoleSpy.mockRestore()
  })

  it('should handle errors in synchronous hook without blocking', async () => {
    const { hook } = await import('../../../../lib/harness-patterns/patterns/hook.server')
    const { createContext } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const innerPattern = {
      name: 'inner',
      fn: vi.fn().mockRejectedValue(new Error('Hook error')),
      config: { patternId: 'inner' }
    }

    const ctx = createContext('test')
    const view = createEventView(ctx)

    const pattern = hook(innerPattern, { trigger: 'error' })

    // Should not throw, should return scope unchanged
    const result = await pattern.fn(
      { id: 'hook', data: ctx.data, events: [], startTime: Date.now() },
      view
    )

    expect(result).toBeDefined()
    expect(consoleSpy).toHaveBeenCalled()
    expect(consoleSpy.mock.calls[0][0]).toContain('Hook error error')

    consoleSpy.mockRestore()
  })

  it('should support different trigger types', async () => {
    const { hook } = await import('../../../../lib/harness-patterns/patterns/hook.server')

    const innerPattern = {
      name: 'inner',
      fn: vi.fn(async (scope) => scope),
      config: { patternId: 'inner' }
    }

    const triggers = ['session_close', 'error', 'approval_timeout', 'custom'] as const

    for (const trigger of triggers) {
      const pattern = hook(innerPattern, { trigger })
      expect(pattern.name).toBe(`hook:${trigger}(inner)`)
    }
  })
})
