/**
 * retriever Pattern Tests
 *
 * The retriever forms ONE query (compacted intent → last message → last-N
 * turns), fans it out to injected backends, merges hits closest-first capped at
 * k, sets `scope.data.matches`, and emits a `tool_result` for the synthesizer.
 * Backends are mocked — this is the framework-pure pattern, no app deps.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type {
  ContextEvent,
  EventType,
  UnifiedContext,
  ToolResultEventData,
} from '../../../../lib/harness-patterns'
import type {
  RetrieverBackend,
  RetrievalHit,
} from '../../../../lib/harness-patterns/patterns/retriever.server'

vi.mock('../../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

// Mock the BAML client (the retriever dynamically imports it for RetrieveQuery).
vi.mock('../../../../../baml_client', () => ({
  b: { RetrieveQuery: vi.fn(async () => 'rewritten search query') },
}))

// Collector must be a real class so `new Collector()` works + has `.last`.
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
          selected: true,
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

const PATTERN_ID = 'retriever'

async function load() {
  const { retriever } = await import(
    '../../../../lib/harness-patterns/patterns/retriever.server'
  )
  const { createScope } = await import('../../../../lib/harness-patterns/context.server')
  const { createEventView } = await import('../../../../lib/harness-patterns/patterns')
  const { b } = await import('../../../../../baml_client')
  return { retriever, createScope, createEventView, b }
}

/** A mock backend that records the query it received and returns canned hits. */
function mockBackend(
  name: string,
  hits: RetrievalHit[],
  opts: { type?: RetrieverBackend['type']; throws?: Error } = {},
): RetrieverBackend & { calls: Array<{ text: string; intent?: string; k: number }> } {
  const calls: Array<{ text: string; intent?: string; k: number }> = []
  return {
    name,
    type: opts.type ?? 'vector',
    calls,
    async search({ text, intent }, { k }) {
      calls.push({ text, intent, k })
      if (opts.throws) throw opts.throws
      return hits
    },
  }
}

function hit(backend: string, id: string, score: number): RetrievalHit {
  return { backend, id, content: `content-${id}`, source: `${id}.txt`, score }
}

const userMsg = (content: string, ts = 1): Ev => ({
  type: 'user_message',
  ts,
  patternId: 'harness',
  data: { content },
})

async function run(
  scopeData: Record<string, unknown>,
  events: Ev[],
  config: Parameters<Awaited<ReturnType<typeof load>>['retriever']>[0],
) {
  const { retriever, createScope, createEventView, b } = await load()
  const pattern = retriever(config)
  const scope = createScope(PATTERN_ID, scopeData)
  const view = createEventView(ctxOf(events), pattern.config.viewConfig, PATTERN_ID)
  const result = await pattern.fn(scope, view)
  return { pattern, result, baml: b }
}

function toolResults(events: ContextEvent[]): ToolResultEventData[] {
  return events
    .filter((e) => e.type === 'tool_result')
    .map((e) => e.data as ToolResultEventData)
}

describe('retriever', () => {
  beforeEach(() => vi.clearAllMocks())

  it('exports a factory that returns a zero-turn ConfiguredPattern', async () => {
    const { retriever } = await load()
    const pattern = retriever({ backends: [], patternId: PATTERN_ID })
    expect(pattern.name).toBe('retriever')
    expect(pattern.config.patternId).toBe('retriever')
    expect(pattern.estimateTurns?.({} as never)).toBe(0)
  })

  it('stamps backendKinds on its resolved config (the seam pattern-capabilities reads)', async () => {
    const { retriever } = await load()
    const pattern = retriever({
      backends: [mockBackend('redis', []), mockBackend('supabase', [])],
      patternId: PATTERN_ID,
    })
    expect((pattern.config as { backendKinds?: string[] }).backendKinds).toEqual([
      'redis',
      'supabase',
    ])
  })

  it('uses the raw last user message as the query by default (ignores scope.data.intent)', async () => {
    const backend = mockBackend('redis', [hit('redis', 'a', 0.1)])
    const { result, baml } = await run(
      { intent: 'some classified intent' },
      [userMsg('what was it again?')],
      { backends: [backend], k: 5 },
    )
    expect(backend.calls).toHaveLength(1)
    // The user's own words are the query — NOT the router/compacted intent.
    expect(backend.calls[0].text).toBe('what was it again?')
    // intent is still passed through as a context hint.
    expect(backend.calls[0].intent).toBe('some classified intent')
    expect(baml.RetrieveQuery).not.toHaveBeenCalled() // no rewrite without generateQuery
    expect((result.data as { matches?: RetrievalHit[] }).matches).toHaveLength(1)
  })

  it('uses the latest user message across multiple turns', async () => {
    const backend = mockBackend('redis', [])
    const { result } = await run({}, [userMsg('first'), userMsg('latest question')], {
      backends: [backend],
    })
    expect(backend.calls[0].text).toBe('latest question')
    expect(backend.calls[0].intent).toBeUndefined()
    expect((result.data as { matches?: RetrievalHit[] }).matches).toEqual([])
  })

  it('widens the query to the last N user turns when turnWindow is set (no LLM)', async () => {
    const backend = mockBackend('redis', [])
    const { baml } = await run(
      {},
      [userMsg('alpha', 1), userMsg('beta', 2), userMsg('gamma', 3)],
      { backends: [backend], turnWindow: 3 },
    )
    expect(backend.calls[0].text).toContain('alpha')
    expect(backend.calls[0].text).toContain('gamma')
    expect(baml.RetrieveQuery).not.toHaveBeenCalled()
  })

  it('with generateQuery + history, rewrites the query via RetrieveQuery', async () => {
    const backend = mockBackend('redis', [])
    const { baml } = await run(
      {},
      [
        userMsg('what is RAG?', 1),
        { type: 'assistant_message', ts: 2, patternId: 'synth', data: { content: 'RAG is…' } },
        userMsg('tell me more about that', 3),
      ],
      { backends: [backend], generateQuery: true },
    )
    expect(baml.RetrieveQuery).toHaveBeenCalledTimes(1)
    const [history, latest] = vi.mocked(baml.RetrieveQuery).mock.calls[0]
    expect(latest).toBe('tell me more about that')
    expect(history.length).toBe(2) // prior user + assistant
    expect(backend.calls[0].text).toBe('rewritten search query')
  })

  it('with generateQuery but NO history (turn 1), searches verbatim — no LLM call', async () => {
    const backend = mockBackend('redis', [])
    const { baml } = await run({}, [userMsg('what is RAG?')], {
      backends: [backend],
      generateQuery: true,
    })
    expect(baml.RetrieveQuery).not.toHaveBeenCalled()
    expect(backend.calls[0].text).toBe('what is RAG?')
  })

  it('falls back to the raw message + tracks an error when RetrieveQuery throws', async () => {
    const { retriever, createScope, createEventView, b } = await load()
    vi.mocked(b.RetrieveQuery).mockRejectedValueOnce(new Error('describe model down'))
    const backend = mockBackend('redis', [hit('redis', 'a', 0.1)])
    const pattern = retriever({ backends: [backend], generateQuery: true, patternId: PATTERN_ID })
    const scope = createScope(PATTERN_ID, {})
    const view = createEventView(
      ctxOf([userMsg('first', 1), userMsg('again', 2)]),
      pattern.config.viewConfig,
      PATTERN_ID,
    )
    const result = await pattern.fn(scope, view)
    // Degrades to the raw latest message and still searches.
    expect(backend.calls[0].text).toBe('again')
    expect((result.data as { matches: RetrievalHit[] }).matches).toHaveLength(1)
    const errors = result.events.filter((e) => e.type === 'error')
    expect(errors.length).toBeGreaterThan(0)
    expect(JSON.stringify(errors[0].data)).toContain('describe model down')
  })

  it('fans out to all backends and merges closest-first, capped at k', async () => {
    const redis = mockBackend('redis', [hit('redis', 'r1', 0.5), hit('redis', 'r2', 0.2)])
    const supa = mockBackend('supabase', [hit('supabase', 's1', 0.1), hit('supabase', 's2', 0.9)])
    const { result } = await run({ intent: 'q' }, [userMsg('q')], {
      backends: [redis, supa],
      k: 3,
    })
    const matches = (result.data as { matches: RetrievalHit[] }).matches
    expect(matches).toHaveLength(3) // capped at k=3 (4 hits available)
    expect(matches.map((m) => m.id)).toEqual(['s1', 'r2', 'r1']) // 0.1 < 0.2 < 0.5
    expect(redis.calls[0].k).toBe(3)
    expect(supa.calls[0].k).toBe(3)
  })

  it('sorts hits without a score last', async () => {
    const b = mockBackend('redis', [
      { backend: 'redis', id: 'noscore', content: 'x' },
      hit('redis', 'scored', 0.4),
    ])
    const { result } = await run({ intent: 'q' }, [userMsg('q')], { backends: [b], k: 5 })
    const matches = (result.data as { matches: RetrievalHit[] }).matches
    expect(matches.map((m) => m.id)).toEqual(['scored', 'noscore'])
  })

  it('emits a tool_result the synthesizer can read, with matches + backends + query', async () => {
    const backend = mockBackend('redis', [hit('redis', 'a', 0.1)])
    const { result } = await run({}, [userMsg('the query')], {
      backends: [backend],
    })
    const trs = toolResults(result.events)
    expect(trs).toHaveLength(1)
    expect(trs[0].tool).toBe('retriever')
    expect(trs[0].success).toBe(true)
    const payload = trs[0].result as {
      matches: RetrievalHit[]
      backends: string[]
      query: string
      references: unknown[]
    }
    expect(payload.matches).toHaveLength(1)
    expect(payload.backends).toEqual(['redis'])
    expect(payload.query).toBe('the query')
    expect(Array.isArray(payload.references)).toBe(true) // no locator on plain hits
    expect(trs[0].summary).toContain('1 match')
  })

  it('builds typed references from hits that carry a source locator', async () => {
    const located: RetrievalHit = {
      backend: 'redis',
      id: 'doc1:2',
      content: 'the matched chunk',
      source: 'notes.md',
      score: 0.2,
      docId: 'doc1',
      chunkIndex: 2,
      startOffset: 10,
      endOffset: 42,
    }
    // A web-style hit with no locator must NOT produce a reference.
    const unlocated: RetrievalHit = { backend: 'web', id: 'u1', content: 'x', score: 0.1 }
    const backend = mockBackend('redis', [located, unlocated])
    const { result } = await run({}, [userMsg('q')], { backends: [backend], k: 5 })
    const refs = (result.events.find((e) => e.type === 'tool_result')!.data as {
      result: { references: RetrievalHit[] }
    }).result.references
    expect(refs).toEqual([
      { source: 'notes.md', docId: 'doc1', chunkIndex: 2, startOffset: 10, endOffset: 42, score: 0.2 },
    ])
  })

  it('reports "no matches" (empty) without erroring when backends find nothing', async () => {
    const b = mockBackend('redis', [])
    const { result } = await run({ intent: 'q' }, [userMsg('q')], { backends: [b] })
    expect((result.data as { matches: RetrievalHit[] }).matches).toEqual([])
    expect(toolResults(result.events)[0].summary).toBe('no matches')
    expect(result.events.some((e) => e.type === 'error')).toBe(false)
  })

  it('isolates a failing backend: error event + the other backend still contributes', async () => {
    const ok = mockBackend('redis', [hit('redis', 'a', 0.3)])
    const bad = mockBackend('supabase', [], { throws: new Error('pgvector down') })
    const { result } = await run({ intent: 'q' }, [userMsg('q')], {
      backends: [ok, bad],
      k: 5,
    })
    const matches = (result.data as { matches: RetrievalHit[] }).matches
    expect(matches.map((m) => m.id)).toEqual(['a'])
    const errors = result.events.filter((e) => e.type === 'error')
    expect(errors).toHaveLength(1)
    expect(JSON.stringify(errors[0].data)).toContain('pgvector down')
    expect(JSON.stringify(errors[0].data)).toContain('supabase')
    // Still emits a tool_result with the surviving hit.
    expect(toolResults(result.events)[0].success).toBe(true)
  })

  it('short-circuits to empty matches when there are no backends', async () => {
    const { result } = await run({ intent: 'q' }, [userMsg('q')], { backends: [] })
    expect((result.data as { matches: RetrievalHit[] }).matches).toEqual([])
    expect(toolResults(result.events)).toHaveLength(1)
  })

  it('short-circuits when there is no query text at all', async () => {
    const b = mockBackend('redis', [hit('redis', 'a', 0.1)])
    const { result } = await run({}, [], { backends: [b] })
    expect(b.calls).toHaveLength(0)
    expect((result.data as { matches: RetrievalHit[] }).matches).toEqual([])
  })
})
