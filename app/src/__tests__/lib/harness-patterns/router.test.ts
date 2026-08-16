/**
 * Router Pattern Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock server-only imports
vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn()
}))

// Mock routing
const mockRouteMessageOp = vi.fn()
vi.mock('../../../lib/harness-patterns/routing.server', () => ({
  routeMessageOp: (...args: unknown[]) => mockRouteMessageOp(...args)
}))

describe('router', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRouteMessageOp.mockResolvedValue({
      intent: 'Test intent',
      tool_call_needed: true,
      tool_name: 'neo4j',
      response_text: ''
    })
  })

  it('should export router function', async () => {
    const { router } = await import('../../../lib/harness-patterns/patterns/router.server')
    expect(router).toBeDefined()
    expect(typeof router).toBe('function')
  })

  it('should create a ConfiguredPattern', async () => {
    const { router } = await import('../../../lib/harness-patterns/patterns/router.server')

    const routeDescriptions = {
      neo4j: 'Database queries',
      web: 'Web search'
    }

    const pattern = router(routeDescriptions)

    expect(pattern.name).toBe('router')
    expect(pattern.fn).toBeDefined()
  })

  it('should set scope.data.route when tool is needed', async () => {
    const { router } = await import('../../../lib/harness-patterns/patterns/router.server')
    const { createContext } = await import('../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../lib/harness-patterns/patterns/event-view.server')

    mockRouteMessageOp.mockResolvedValue({
      intent: 'Query database',
      tool_call_needed: true,
      tool_name: 'neo4j',
      response_text: ''
    })

    const ctx = createContext<{ route?: string; intent?: string }>('test')
    ctx.events.push({
      type: 'user_message',
      ts: Date.now(),
      patternId: 'router',
      data: { content: 'Query the database' }
    })
    const view = createEventView(ctx)

    const pattern = router({ neo4j: 'Database queries', web: 'Web search' })
    const result = await pattern.fn(
      { id: 'router', data: ctx.data, events: [], startTime: Date.now() },
      view
    )

    expect(result.data.route).toBe('neo4j')
    expect(result.data.intent).toBe('Query database')
  })

  it('should return conversational response when no tool needed', async () => {
    const { router } = await import('../../../lib/harness-patterns/patterns/router.server')
    const { createContext } = await import('../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../lib/harness-patterns/patterns/event-view.server')

    mockRouteMessageOp.mockResolvedValue({
      intent: 'Greeting',
      tool_call_needed: false,
      tool_name: null,
      response_text: 'Hello! How can I help you?'
    })

    const ctx = createContext<{ response?: string; routerResponse?: string; route?: string }>('test')
    ctx.events.push({
      type: 'user_message',
      ts: Date.now(),
      patternId: 'router',
      data: { content: 'Hello' }
    })
    const view = createEventView(ctx)

    const pattern = router({ neo4j: 'Database queries' })
    const result = await pattern.fn(
      { id: 'router', data: ctx.data, events: [], startTime: Date.now() },
      view
    )

    expect(result.data.response).toBe('Hello! How can I help you?')
    expect(result.data.route).toBe('user')
  })

  it('should track error when tool_call_needed but no tool_name', async () => {
    const { router } = await import('../../../lib/harness-patterns/patterns/router.server')
    const { createContext } = await import('../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../lib/harness-patterns/patterns/event-view.server')

    mockRouteMessageOp.mockResolvedValue({
      intent: 'Ambiguous',
      tool_call_needed: true,
      tool_name: null,
      response_text: ''
    })

    const ctx = createContext('test')
    ctx.events.push({
      type: 'user_message',
      ts: Date.now(),
      patternId: 'router',
      data: { content: 'Do something' }
    })
    const view = createEventView(ctx)

    const pattern = router({ neo4j: 'Database queries' })
    const result = await pattern.fn(
      { id: 'router', data: ctx.data, events: [], startTime: Date.now() },
      view
    )

    const errorEvents = result.events.filter(e => e.type === 'error')
    expect(errorEvents.length).toBeGreaterThan(0)
    expect(JSON.stringify(errorEvents[0].data)).toContain('tool_call_needed but no tool_name')
  })

  it('should handle errors gracefully', async () => {
    const { router } = await import('../../../lib/harness-patterns/patterns/router.server')
    const { createContext } = await import('../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../lib/harness-patterns/patterns/event-view.server')

    mockRouteMessageOp.mockRejectedValue(new Error('Routing failed'))

    const ctx = createContext('test')
    ctx.events.push({
      type: 'user_message',
      ts: Date.now(),
      patternId: 'router',
      data: { content: 'Query' }
    })
    const view = createEventView(ctx)

    const pattern = router({ neo4j: 'Database queries' })
    const result = await pattern.fn(
      { id: 'router', data: ctx.data, events: [], startTime: Date.now() },
      view
    )

    const errorEvents = result.events.filter(e => e.type === 'error')
    expect(errorEvents.length).toBeGreaterThan(0)
    expect(JSON.stringify(errorEvents[0].data)).toContain('Routing failed')
  })

  it('should update scope data with routing info', async () => {
    const { router } = await import('../../../lib/harness-patterns/patterns/router.server')
    const { createContext } = await import('../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../lib/harness-patterns/patterns/event-view.server')

    mockRouteMessageOp.mockResolvedValue({
      intent: 'Database query intent',
      tool_call_needed: true,
      tool_name: 'neo4j',
      response_text: 'Router response'
    })

    const ctx = createContext<{ route?: string; intent?: string; routerResponse?: string }>('test')
    ctx.events.push({
      type: 'user_message',
      ts: Date.now(),
      patternId: 'router',
      data: { content: 'Query' }
    })
    const view = createEventView(ctx)

    const pattern = router({ neo4j: 'Database queries' })
    const result = await pattern.fn(
      { id: 'router', data: ctx.data, events: [], startTime: Date.now() },
      view
    )

    expect(result.data.route).toBe('neo4j')
    expect(result.data.intent).toBe('Database query intent')
    expect(result.data.routerResponse).toBe('Router response')
  })
})

describe('routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should export routes function', async () => {
    const { routes } = await import('../../../lib/harness-patterns/patterns/router.server')
    expect(routes).toBeDefined()
    expect(typeof routes).toBe('function')
  })

  it('should create a ConfiguredPattern with route names in name', async () => {
    const { routes } = await import('../../../lib/harness-patterns/patterns/router.server')

    const neo4jFn = vi.fn(async (scope: any) => scope)
    const webFn = vi.fn(async (scope: any) => scope)

    const pattern = routes({
      neo4j: { name: 'neo4j-loop', fn: neo4jFn, config: { patternId: 'neo4j' } },
      web: { name: 'web-loop', fn: webFn, config: { patternId: 'web' } }
    })

    expect(pattern.name).toContain('neo4j')
    expect(pattern.name).toContain('web')
    expect(pattern.fn).toBeDefined()
  })

  it('should dispatch to correct pattern based on scope.data.route', async () => {
    const { routes } = await import('../../../lib/harness-patterns/patterns/router.server')
    const { createContext } = await import('../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../lib/harness-patterns/patterns/event-view.server')

    const neo4jFn = vi.fn(async (scope: any) => {
      scope.data = { ...scope.data, response: 'Neo4j result' }
      return scope
    })
    const webFn = vi.fn(async (scope: any) => scope)

    const ctx = createContext<{ route?: string; response?: string }>('test')
    const view = createEventView(ctx)

    const dispatchPattern = routes({
      neo4j: { name: 'neo4j-loop', fn: neo4jFn, config: { patternId: 'neo4j' } },
      web: { name: 'web-loop', fn: webFn, config: { patternId: 'web' } }
    })

    await dispatchPattern.fn(
      { id: 'routes', data: { ...ctx.data, route: 'neo4j' }, events: [], startTime: Date.now() },
      view
    )

    expect(neo4jFn).toHaveBeenCalled()
    expect(webFn).not.toHaveBeenCalled()
  })

  it('should throw when routes is called without router (route is undefined)', async () => {
    const { routes } = await import('../../../lib/harness-patterns/patterns/router.server')
    const { createContext } = await import('../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../lib/harness-patterns/patterns/event-view.server')

    const neo4jFn = vi.fn(async (scope: any) => scope)

    const ctx = createContext('test')
    const view = createEventView(ctx)
    const scope = { id: 'routes', data: ctx.data, events: [] as any[], startTime: Date.now() }

    const dispatchPattern = routes({
      neo4j: { name: 'neo4j-loop', fn: neo4jFn, config: { patternId: 'neo4j' } }
    })

    await expect(dispatchPattern.fn(scope, view)).rejects.toThrow('routes() called without')
  })

  it('should pass through for direct-response route (user)', async () => {
    const { routes } = await import('../../../lib/harness-patterns/patterns/router.server')
    const { createContext } = await import('../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../lib/harness-patterns/patterns/event-view.server')

    const neo4jFn = vi.fn(async (scope: any) => scope)

    const ctx = createContext('test')
    const view = createEventView(ctx)
    const scope = { id: 'routes', data: { ...ctx.data, route: 'user' }, events: [] as any[], startTime: Date.now() }

    const dispatchPattern = routes({
      neo4j: { name: 'neo4j-loop', fn: neo4jFn, config: { patternId: 'neo4j' } }
    })

    const result = await dispatchPattern.fn(scope, view)

    expect(neo4jFn).not.toHaveBeenCalled()
    expect(result).toBe(scope)
  })

  it('should track error when route not found in patternMap', async () => {
    const { routes } = await import('../../../lib/harness-patterns/patterns/router.server')
    const { createContext } = await import('../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../lib/harness-patterns/patterns/event-view.server')

    const neo4jFn = vi.fn(async (scope: any) => scope)

    const ctx = createContext('test')
    const view = createEventView(ctx)

    const dispatchPattern = routes({
      neo4j: { name: 'neo4j-loop', fn: neo4jFn, config: { patternId: 'neo4j' } }
    })

    const result = await dispatchPattern.fn(
      { id: 'routes', data: { ...ctx.data, route: 'unknown_route' }, events: [], startTime: Date.now() },
      view
    )

    const errorEvents = result.events.filter((e: any) => e.type === 'error')
    expect(errorEvents.length).toBeGreaterThan(0)
    expect(JSON.stringify(errorEvents[0].data)).toContain('Unknown route')
  })

  it('should keep pattern response after dispatch', async () => {
    const { routes } = await import('../../../lib/harness-patterns/patterns/router.server')
    const { createContext } = await import('../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../lib/harness-patterns/patterns/event-view.server')

    const neo4jFn = vi.fn(async (scope: any) => {
      scope.data = { ...scope.data, response: 'Pattern response' }
      return scope
    })

    const ctx = createContext<{ route?: string; response?: string }>('test')
    const view = createEventView(ctx)

    const dispatchPattern = routes({
      neo4j: { name: 'neo4j-loop', fn: neo4jFn, config: { patternId: 'neo4j' } }
    })

    const result = await dispatchPattern.fn(
      { id: 'routes', data: { ...ctx.data, route: 'neo4j' }, events: [], startTime: Date.now() },
      view
    )

    expect(result.data.response).toBe('Pattern response')
  })

  it('should merge events from executed pattern', async () => {
    const { routes } = await import('../../../lib/harness-patterns/patterns/router.server')
    const { createContext } = await import('../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../lib/harness-patterns/patterns/event-view.server')

    const neo4jFn = vi.fn(async (scope: any) => {
      scope.events.push({
        type: 'tool_call' as const,
        ts: Date.now(),
        patternId: 'neo4j',
        data: { tool: 'test' }
      })
      return scope
    })

    const ctx = createContext('test')
    const view = createEventView(ctx)

    const dispatchPattern = routes({
      neo4j: { name: 'neo4j-loop', fn: neo4jFn, config: { patternId: 'neo4j' } }
    })

    const result = await dispatchPattern.fn(
      { id: 'routes', data: { ...ctx.data, route: 'neo4j' }, events: [], startTime: Date.now() },
      view
    )

    const toolCalls = result.events.filter((e: any) => e.type === 'tool_call')
    expect(toolCalls.length).toBeGreaterThan(0)
  })

  it('should add pattern_enter and pattern_exit events on dispatch', async () => {
    const { routes } = await import('../../../lib/harness-patterns/patterns/router.server')
    const { createContext } = await import('../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../lib/harness-patterns/patterns/event-view.server')

    const neo4jFn = vi.fn(async (scope: any) => scope)

    const ctx = createContext('test')
    const view = createEventView(ctx)

    const dispatchPattern = routes({
      neo4j: { name: 'neo4j-loop', fn: neo4jFn, config: { patternId: 'neo4j' } }
    })

    const result = await dispatchPattern.fn(
      { id: 'routes', data: { ...ctx.data, route: 'neo4j' }, events: [], startTime: Date.now() },
      view
    )

    const enterEvents = result.events.filter((e: any) => e.type === 'pattern_enter')
    const exitEvents = result.events.filter((e: any) => e.type === 'pattern_exit')
    expect(enterEvents.length).toBeGreaterThanOrEqual(1)
    expect(exitEvents.length).toBeGreaterThanOrEqual(1)
  })
})
