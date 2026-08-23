/**
 * Cross-turn `scope.data` pollution regressions (SA-H2 / SA-H3 / sf-L4)
 *
 * `scope.data` survives the turn boundary — `continueSession` only deletes
 * `response`/`hasError`/`errorMessage`. So a pattern that fails and returns
 * `scope` untouched hands the NEXT stage the PREVIOUS turn's value as if this
 * turn had produced it. `planner`'s `clearPlan` is the reference fix; these
 * tests pin the same discipline for `router`, `compactIntent` and `retriever`.
 *
 * Each test seeds the pattern's scope with turn N-1 data (what a real
 * `continueSession` would carry in), fails the turn, and asserts the stale
 * value is gone rather than reused.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ContextEvent, EventType, UnifiedContext } from '../../../../lib/harness-patterns'
import type { RetrievalHit } from '../../../../lib/harness-patterns/patterns/retriever.server'

vi.mock('../../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

const mockRouteMessageOp = vi.fn()
vi.mock('../../../../lib/harness-patterns/routing.server', () => ({
  routeMessageOp: (...args: unknown[]) => mockRouteMessageOp(...args),
}))

vi.mock('../../../../../baml_client', () => ({
  b: {
    CompactIntent: vi.fn(async () => 'a freshly compacted brief'),
    RetrieveQuery: vi.fn(async () => 'rewritten search query'),
  },
}))

// Collector must be a real class so `new Collector()` works and has `.last`.
vi.mock('@boundaryml/baml', () => {
  class MockCollector {
    last = {
      rawLlmResponse: 'raw',
      usage: { inputTokens: 10, outputTokens: 4 },
      calls: [
        {
          httpRequest: { body: { messages: [] } },
          provider: 'anthropic',
          clientName: 'DescribeAnthropic',
        },
      ],
    }
    constructor(_name?: string) {}
  }
  return { Collector: MockCollector }
})

type Ev = { type: EventType; ts: number; patternId: string; data: unknown }

function ctxOf(events: Ev[]): UnifiedContext<Record<string, unknown>> {
  const lastUser = events.filter((e) => e.type === 'user_message').slice(-1)[0]
  return {
    sessionId: 'test',
    createdAt: 1,
    events: events as ContextEvent[],
    status: 'running',
    data: {},
    input: lastUser ? (lastUser.data as { content: string }).content : '',
  }
}

const userMsg = (content: string, ts = 1): Ev => ({
  type: 'user_message',
  ts,
  patternId: 'harness',
  data: { content },
})

const assistantMsg = (content: string, ts = 2): Ev => ({
  type: 'assistant_message',
  ts,
  patternId: 'harness',
  data: { content },
})

async function load() {
  const { router, routes } = await import('../../../../lib/harness-patterns/patterns/router.server')
  const { compactIntent } =
    await import('../../../../lib/harness-patterns/patterns/compactIntent.server')
  const { retriever } = await import('../../../../lib/harness-patterns/patterns/retriever.server')
  const { createScope } = await import('../../../../lib/harness-patterns/context.server')
  const { createEventView } = await import('../../../../lib/harness-patterns/patterns')
  const { b } = await import('../../../../../baml_client')
  return { router, routes, compactIntent, retriever, createScope, createEventView, b }
}

// ============================================================================
// SA-H2 — router failure re-runs the previous turn's route AND intent
// ============================================================================

describe('router: cross-turn route/intent pollution (SA-H2)', () => {
  beforeEach(() => vi.clearAllMocks())

  /** Run the router over a turn-2 context, carrying turn-1 data in. */
  async function runTurn2(priorData: Record<string, unknown>) {
    const { router, createScope, createEventView } = await load()
    const events = [
      userMsg('list the Concept nodes', 1),
      assistantMsg('Here they are', 2),
      userMsg('and now?', 3),
    ]
    const pattern = router({ neo4j: 'Database queries', web: 'Web search' })
    const scope = createScope('router', priorData)
    const view = createEventView(ctxOf(events), pattern.config.viewConfig, 'router')
    return { result: await pattern.fn(scope, view), routes: (await load()).routes }
  }

  it('A: a turn-2 throw does not re-dispatch turn 1’s route or reuse its intent', async () => {
    mockRouteMessageOp.mockRejectedValue(new Error('router 429'))

    const { result, routes } = await runTurn2({
      route: 'neo4j',
      intent: 'List every Concept node in the graph',
    })

    // The failure is reported…
    const errors = result.events.filter((e) => e.type === 'error')
    expect(errors.length).toBeGreaterThan(0)
    expect(JSON.stringify(errors[0].data)).toContain('router 429')
    // …and turn 1's decision is gone, not carried forward.
    expect((result.data as { route?: string }).route).toBeUndefined()
    expect((result.data as { intent?: string }).intent).toBeUndefined()

    // Downstream: routes() must NOT run the neo4j branch on the stale route.
    const neo4jFn = vi.fn(async (s: unknown) => s)
    const dispatch = routes({
      neo4j: { name: 'neo4j-loop', fn: neo4jFn as never, config: { patternId: 'neo4j' } },
    })
    const { createScope, createEventView } = await load()
    const dispatchScope = createScope('routes', result.data)
    await expect(dispatch.fn(dispatchScope as never, createEventView(ctxOf([])))).rejects.toThrow(
      /data\.route is undefined/,
    )
    expect(neo4jFn).not.toHaveBeenCalled()
  })

  it('B: a turn-2 throw after a turn-1 conversational route surfaces the failure instead of an empty reply', async () => {
    mockRouteMessageOp.mockRejectedValue(new Error('router 503'))

    // Turn 1 answered conversationally: route = the direct-response sentinel.
    // `continueSession` clears `response`, so passing that route through
    // routes() used to reach the synthesizer with nothing to say.
    const { result, routes } = await runTurn2({
      route: 'user',
      intent: 'Say hello back',
      routerResponse: 'Hello!',
    })

    expect((result.data as { route?: string }).route).toBeUndefined()
    expect((result.data as { intent?: string }).intent).toBeUndefined()

    const { createScope, createEventView } = await load()
    const dispatch = routes({
      neo4j: {
        name: 'neo4j-loop',
        fn: (async (s: unknown) => s) as never,
        config: { patternId: 'neo4j' },
      },
    })
    // The failure surfaces as a throw (runChain turns it into ctx.status
    // 'error'); it is NOT a silent pass-through to an empty response.
    await expect(
      dispatch.fn(createScope('routes', result.data) as never, createEventView(ctxOf([]))),
    ).rejects.toThrow(/router failed this turn/)
  })

  it('clears route + intent on the tool_call_needed-but-no-tool_name path too', async () => {
    mockRouteMessageOp.mockResolvedValue({
      intent: 'Ambiguous',
      tool_call_needed: true,
      tool_name: null,
      response_text: '',
    })

    const { result } = await runTurn2({ route: 'neo4j', intent: 'List every Concept node' })

    expect(JSON.stringify(result.events.filter((e) => e.type === 'error')[0].data)).toContain(
      'no tool_name',
    )
    expect((result.data as { route?: string }).route).toBeUndefined()
    expect((result.data as { intent?: string }).intent).toBeUndefined()
  })

  it('still writes a fresh route + intent on the happy path', async () => {
    mockRouteMessageOp.mockResolvedValue({
      intent: 'Fresh intent',
      tool_call_needed: true,
      tool_name: 'web',
      response_text: '',
    })

    const { result } = await runTurn2({ route: 'neo4j', intent: 'stale intent' })

    expect((result.data as { route?: string }).route).toBe('web')
    expect((result.data as { intent?: string }).intent).toBe('Fresh intent')
  })
})

// ============================================================================
// SA-H3 — compactIntent leaves the previous turn's intent on failure
// ============================================================================

describe('compactIntent: cross-turn intent pollution (SA-H3)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('a turn-N failure does not hand the actor turn N-1’s brief', async () => {
    const { compactIntent, createScope, createEventView, b } = await load()
    vi.mocked(b.CompactIntent).mockRejectedValueOnce(new Error('describe model unavailable'))

    const events = [
      userMsg('write a Fibonacci script to /work/fib.py', 1),
      assistantMsg('Done — /work/fib.py', 2),
      userMsg('now delete it', 3),
    ]
    const pattern = compactIntent({ patternId: 'compactIntent' })
    // Turn N-1's brief, carried across the turn boundary on scope.data.
    const scope = createScope('compactIntent', {
      intent: 'Write a Fibonacci script to /work/fib.py',
    })
    const view = createEventView(ctxOf(events), pattern.config.viewConfig, 'compactIntent')

    const result = await pattern.fn(scope, view)

    // The actor must fall back to the raw message ("now delete it"), NOT
    // re-execute the previous brief with real file side-effects.
    expect((result.data as { intent?: string }).intent).toBeUndefined()
    const errors = result.events.filter((e) => e.type === 'error')
    expect(errors.length).toBeGreaterThan(0)
    expect(JSON.stringify(errors[0].data)).toContain('describe model unavailable')
  })

  it('clears the stale intent when the view holds no message to rewrite', async () => {
    const { compactIntent, createScope, createEventView, b } = await load()
    const pattern = compactIntent({ patternId: 'compactIntent' })
    const scope = createScope('compactIntent', { intent: 'a brief from an earlier turn' })
    const view = createEventView(ctxOf([]), pattern.config.viewConfig, 'compactIntent')

    const result = await pattern.fn(scope, view)

    expect(b.CompactIntent).not.toHaveBeenCalled()
    expect((result.data as { intent?: string }).intent).toBeUndefined()
  })
})

// ============================================================================
// sf-L4 — retriever outer catch leaves the previous turn's matches
// ============================================================================

describe('retriever: cross-turn matches pollution (sf-L4)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('empties matches when the outer catch fires', async () => {
    const { retriever, createScope, createEventView } = await load()

    // Force a throw between the backend fan-out and the `scope.data.matches`
    // write: the merge step reads `score` on every hit, so a hit whose score
    // access throws lands in the pattern's outer catch. (Two hits — a
    // single-element sort never calls the comparator.)
    const poisoned = {
      backend: 'redis',
      id: 'boom',
      content: 'content-boom',
      get score(): number {
        throw new Error('hit projection blew up')
      },
    } as RetrievalHit
    const backend = {
      name: 'redis',
      type: 'vector' as const,
      search: async () => [poisoned, { backend: 'redis', id: 'ok', content: 'c', score: 0.1 }],
    }

    const pattern = retriever({ backends: [backend], patternId: 'retriever' })
    // Turn N-1's matches, carried across the turn boundary.
    const scope = createScope('retriever', {
      matches: [{ backend: 'redis', id: 'stale', content: 'last turn’s chunk', score: 0.2 }],
    })
    const view = createEventView(
      ctxOf([userMsg('what did the report say?')]),
      pattern.config.viewConfig,
      'retriever',
    )

    const result = await pattern.fn(scope, view)

    const errors = result.events.filter((e) => e.type === 'error')
    expect(errors.length).toBeGreaterThan(0)
    expect(JSON.stringify(errors[0].data)).toContain('hit projection blew up')
    // The stale chunk must not be citable as an answer to this turn.
    expect((result.data as { matches?: RetrievalHit[] }).matches).toEqual([])
  })
})
