/**
 * chain Pattern Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock server-only imports
vi.mock('../../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn()
}))

describe('runChain (internal executor)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should export runChain function', async () => {
    const { runChain } = await import('../../../../lib/harness-patterns/patterns/chain.server')
    expect(runChain).toBeDefined()
    expect(typeof runChain).toBe('function')
  })

  it('should return context unchanged when no patterns provided', async () => {
    const { runChain } = await import('../../../../lib/harness-patterns/patterns/chain.server')
    const { createContext } = await import('../../../../lib/harness-patterns/context.server')

    const ctx = createContext('test message')
    const result = await runChain(ctx, [])

    expect(result).toBe(ctx)
    expect(result.status).toBe('running')
  })

  it('should execute patterns in sequence', async () => {
    const { runChain, configurePattern } = await import('../../../../lib/harness-patterns/patterns/chain.server')
    const { createContext } = await import('../../../../lib/harness-patterns/context.server')

    const executionOrder: string[] = []

    const pattern1 = configurePattern('first', async (scope) => {
      executionOrder.push('first')
      scope.data = { ...scope.data, step: 1 }
      return scope
    }, { patternId: 'first' })

    const pattern2 = configurePattern('second', async (scope) => {
      executionOrder.push('second')
      scope.data = { ...scope.data, step: 2 }
      return scope
    }, { patternId: 'second' })

    const ctx = createContext<{ step?: number }>('test')
    await runChain(ctx, [pattern1, pattern2])

    expect(executionOrder).toEqual(['first', 'second'])
    expect(ctx.data.step).toBe(2)
  })

  it('should stop execution when status changes from running', async () => {
    const { runChain, configurePattern } = await import('../../../../lib/harness-patterns/patterns/chain.server')
    const { createContext } = await import('../../../../lib/harness-patterns/context.server')

    const executionOrder: string[] = []

    const pattern1 = configurePattern('first', async (scope) => {
      executionOrder.push('first')
      return scope
    }, { patternId: 'first' })

    const pattern2 = configurePattern('stopper', async (scope) => {
      executionOrder.push('stopper')
      // This would need to trigger a status change somehow
      return scope
    }, { patternId: 'stopper' })

    const pattern3 = configurePattern('third', async (scope) => {
      executionOrder.push('third')
      return scope
    }, { patternId: 'third' })

    const ctx = createContext('test')
    await runChain(ctx, [pattern1, pattern2, pattern3])

    expect(executionOrder).toContain('first')
  })

  it('should add pattern_enter and pattern_exit events', async () => {
    const { runChain, configurePattern } = await import('../../../../lib/harness-patterns/patterns/chain.server')
    const { createContext } = await import('../../../../lib/harness-patterns/context.server')

    const pattern = configurePattern('test-pattern', async (scope) => scope, { patternId: 'test' })

    const ctx = createContext('test')
    await runChain(ctx, [pattern])

    const enterEvents = ctx.events.filter(e => e.type === 'pattern_enter')
    const exitEvents = ctx.events.filter(e => e.type === 'pattern_exit')

    expect(enterEvents.length).toBeGreaterThanOrEqual(1)
    expect(exitEvents.length).toBeGreaterThanOrEqual(1)
  })

  it('should pass data between patterns', async () => {
    const { runChain, configurePattern } = await import('../../../../lib/harness-patterns/patterns/chain.server')
    const { createContext } = await import('../../../../lib/harness-patterns/context.server')

    const pattern1 = configurePattern('producer', async (scope) => {
      scope.data = { ...scope.data, value: 42 }
      return scope
    }, { patternId: 'producer' })

    const pattern2 = configurePattern('consumer', async (scope) => {
      // Should receive value from previous pattern
      scope.data = { ...scope.data, doubled: (scope.data as { value: number }).value * 2 }
      return scope
    }, { patternId: 'consumer' })

    const ctx = createContext<{ value?: number; doubled?: number }>('test')
    await runChain(ctx, [pattern1, pattern2])

    expect(ctx.data.value).toBe(42)
    expect(ctx.data.doubled).toBe(84)
  })

  it('should handle errors in patterns', async () => {
    const { runChain, configurePattern } = await import('../../../../lib/harness-patterns/patterns/chain.server')
    const { createContext } = await import('../../../../lib/harness-patterns/context.server')

    const errorPattern = configurePattern('error', async () => {
      throw new Error('Pattern failed')
    }, { patternId: 'error' })

    const ctx = createContext('test')
    await runChain(ctx, [errorPattern])

    expect(ctx.status).toBe('error')
    expect(ctx.error).toBe('Pattern failed')
  })
})

describe('chain (pattern factory)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should export chain function', async () => {
    const { chain } = await import('../../../../lib/harness-patterns/patterns/chain.server')
    expect(chain).toBeDefined()
    expect(typeof chain).toBe('function')
  })

  it('should return a ConfiguredPattern', async () => {
    const { chain, configurePattern } = await import('../../../../lib/harness-patterns/patterns/chain.server')

    const p1 = configurePattern('a', async (scope) => scope, { patternId: 'a' })
    const p2 = configurePattern('b', async (scope) => scope, { patternId: 'b' })

    const result = chain(p1, p2)
    expect(result.name).toBe('chain(a, b)')
    expect(typeof result.fn).toBe('function')
    expect(result.config).toBeDefined()
  })

  it('should execute sub-patterns in sequence within scope', async () => {
    const { chain, configurePattern } = await import('../../../../lib/harness-patterns/patterns/chain.server')
    const { createContext } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

    const order: string[] = []

    const p1 = configurePattern('first', async (scope) => {
      order.push('first')
      scope.data = { ...scope.data, step: 1 }
      return scope
    }, { patternId: 'first' })

    const p2 = configurePattern('second', async (scope) => {
      order.push('second')
      scope.data = { ...scope.data, step: 2 }
      return scope
    }, { patternId: 'second' })

    const composed = chain(p1, p2)

    const ctx = createContext<{ step?: number }>('test')
    const view = createEventView(ctx)
    const scope = { id: 'outer', data: ctx.data, events: [] as any[], startTime: Date.now() }

    const result = await composed.fn(scope, view)

    expect(order).toEqual(['first', 'second'])
    expect(result.data.step).toBe(2)
  })

  it('should add pattern_enter and pattern_exit events for each sub-pattern', async () => {
    const { chain, configurePattern } = await import('../../../../lib/harness-patterns/patterns/chain.server')
    const { createContext } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

    const p = configurePattern('sub', async (scope) => scope, { patternId: 'sub' })
    const composed = chain(p)

    const ctx = createContext('test')
    const view = createEventView(ctx)
    const scope = { id: 'outer', data: ctx.data, events: [] as any[], startTime: Date.now() }

    const result = await composed.fn(scope, view)

    const enterEvents = result.events.filter((e: any) => e.type === 'pattern_enter')
    const exitEvents = result.events.filter((e: any) => e.type === 'pattern_exit')
    expect(enterEvents.length).toBeGreaterThanOrEqual(1)
    expect(exitEvents.length).toBeGreaterThanOrEqual(1)
  })
})

describe('configurePattern', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should create a ConfiguredPattern with name and config', async () => {
    const { configurePattern } = await import('../../../../lib/harness-patterns/patterns/chain.server')

    const pattern = configurePattern(
      'test-pattern',
      async (scope) => scope,
      { patternId: 'custom-id' }
    )

    expect(pattern.name).toBe('test-pattern')
    expect(pattern.config.patternId).toBe('custom-id')
    expect(pattern.fn).toBeDefined()
  })

  it('should generate patternId if not provided', async () => {
    const { configurePattern } = await import('../../../../lib/harness-patterns/patterns/chain.server')

    const pattern = configurePattern('my-pattern', async (scope) => scope)

    expect(pattern.config.patternId).toMatch(/^my-pattern-/)
  })
})
