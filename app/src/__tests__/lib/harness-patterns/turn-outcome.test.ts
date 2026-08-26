/**
 * How a turn REPORTS its ending — `settleTurn` in `harness.server.ts`.
 *
 * The defect these pin: `runChain` almost never throws (every pattern catches
 * internally and records an `error` event instead), so all three entry points
 * used to read "the chain returned" as success. A turn whose LLM calls all
 * failed came back `status: 'running'` with `response: ''`, which the SSE route
 * sends as `event: done`, the client marks as a completed run, and
 * `extractStatusFromContext` persists as `'done'`. Observed live on 2026-08-26
 * against the self-hosted deployment: a `BamlTimeoutError` on `LoopController`
 * followed by a `504 inference request was canceled` on `Synthesize` was stored
 * as a successful, empty conversation.
 *
 * Every case here goes through the real `harness` / `continueSession` /
 * `resumeHarness` with a stubbed `runChain`, because the whole point is that
 * the three no longer disagree.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { UnifiedContext } from '../../../lib/harness-patterns/types'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

const mockChain = vi.fn()
vi.mock('../../../lib/harness-patterns/patterns/chain.server', () => ({
  runChain: mockChain,
  chain: vi.fn(),
}))

const { harness, continueSession, resumeHarness } =
  await import('../../../lib/harness-patterns/harness.server')
const { createContext, serializeContext } =
  await import('../../../lib/harness-patterns/context.server')

type Ctx = UnifiedContext<Record<string, unknown>>

/** A no-op pattern; the stubbed `runChain` is what actually mutates the ctx. */
const pattern = { name: 'test', fn: vi.fn(async (scope) => scope), config: { patternId: 'test' } }

/** What a failing pattern does: record an `error` event and return, leaving
 *  `data.response` unset. Exactly `compactExecution`'s catch. */
function recordError(message: string) {
  return async (ctx: Ctx) => {
    ctx.events.push({
      id: `ev-${ctx.events.length}`,
      type: 'error',
      ts: Date.now(),
      patternId: 'response-synth',
      data: { error: message, severity: 'irrecoverable' },
    })
    return ctx
  }
}

const errorEvents = (ctx: Ctx) => ctx.events.filter((e) => e.type === 'error')

beforeEach(() => {
  vi.clearAllMocks()
  mockChain.mockImplementation(async (ctx: Ctx) => ctx)
})

describe('a turn that produced nothing but recorded an error', () => {
  it('reports status error and a message, not an empty success', async () => {
    mockChain.mockImplementation(recordError('BamlTimeoutError: Request timed out'))

    const result = await harness(pattern)('weather in Brussels today')

    expect(result.status).toBe('error')
    expect(result.response).toBe('Error: BamlTimeoutError: Request timed out')
    expect(result.context.error).toBe('BamlTimeoutError: Request timed out')
  })

  it('does not duplicate the error event the pattern already emitted', async () => {
    // The pattern's own event carries the LLM call detail the observability
    // drill-down renders; a second one would double the transcript bubble.
    mockChain.mockImplementation(recordError('504 Gateway Timeout'))

    const result = await harness(pattern)('hi')

    expect(errorEvents(result.context)).toHaveLength(1)
  })

  it('survives the round trip, so the persisted status is error too', async () => {
    mockChain.mockImplementation(recordError('BamlTimeoutError: Request timed out'))

    const result = await harness(pattern)('hi')
    const reloaded = JSON.parse(result.serialized) as Ctx

    expect(reloaded.status).toBe('error')
  })
})

describe('what settleTurn must NOT touch', () => {
  it('leaves a partial answer alone — an error WITH a response is not a failed turn', async () => {
    // The designed shape (#83): the loop exhausts its turns, records a
    // recoverable error, and the synthesizer answers from partial results.
    mockChain.mockImplementation(async (ctx: Ctx) => {
      await recordError('Loop exhausted: reached maxTurns (5)')(ctx)
      ctx.data.response = 'I could only get partway, but here is what I found.'
      return ctx
    })

    const result = await harness(pattern)('hi')

    expect(result.status).toBe('running')
    expect(result.response).toBe('I could only get partway, but here is what I found.')
  })

  it('leaves an empty turn that recorded no error alone', async () => {
    // A chain with no synthesizer legitimately produces no response.
    const result = await harness(pattern)('hi')

    expect(result.status).toBe('running')
    expect(result.response).toBe('')
  })

  it('leaves a paused turn paused — an approval gate ends with no response on purpose', async () => {
    mockChain.mockImplementation(async (ctx: Ctx) => {
      await recordError('a tool failed earlier in this turn')(ctx)
      ctx.status = 'paused'
      return ctx
    })

    const result = await harness(pattern)('hi')

    expect(result.status).toBe('paused')
    expect(result.response).toBe('')
  })
})

describe('the turn boundary on a multi-turn context', () => {
  it('continueSession is not condemned by an error from a PREVIOUS turn', async () => {
    const first = createContext<Record<string, unknown>>('first question', {}, 's1')
    await recordError('BamlTimeoutError: Request timed out')(first)
    first.data.response = 'answered eventually'

    const result = await continueSession(serializeContext(first), [pattern], 'second question')

    // This turn recorded nothing and produced nothing: not a failure.
    expect(result.status).toBe('running')
    expect(result.response).toBe('')
    expect(result.context.error).toBeUndefined()
  })

  it('continueSession still reports this turn’s own failure', async () => {
    const first = createContext<Record<string, unknown>>('first question', {}, 's1')
    first.data.response = 'answered'

    mockChain.mockImplementation(recordError('504 Gateway Timeout'))
    const result = await continueSession(serializeContext(first), [pattern], 'second question')

    expect(result.status).toBe('error')
    expect(result.response).toBe('Error: 504 Gateway Timeout')
  })

  it('resumeHarness reports a failed resume, not a silent success', async () => {
    const paused = createContext<Record<string, unknown>>('write to the graph', {}, 's1')
    paused.status = 'paused'

    mockChain.mockImplementation(recordError('BamlTimeoutError: Request timed out'))
    const result = await resumeHarness(serializeContext(paused), [pattern], true)

    expect(result.status).toBe('error')
    expect(result.response).toBe('Error: BamlTimeoutError: Request timed out')
  })

  it('resumeHarness is not condemned by the error that preceded the gate', async () => {
    const paused = createContext<Record<string, unknown>>('write to the graph', {}, 's1')
    await recordError('a tool failed before the approval gate')(paused)
    paused.status = 'paused'

    const result = await resumeHarness(serializeContext(paused), [pattern], true)

    expect(result.status).toBe('running')
    expect(result.context.error).toBeUndefined()
  })
})
