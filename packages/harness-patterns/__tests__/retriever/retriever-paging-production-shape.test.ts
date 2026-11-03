/**
 * The retriever's `page: true` turn scoping, on the events PRODUCTION builds
 * (#927 slice 2, fix round 2).
 *
 * `createEvent` (context.server.ts) sets id, type, ts, patternId, data — NO
 * `turn` field — and turn boundaries are *derived* from `user_message` events,
 * the rule `sliceByLastNTurns` implements (event-view.server.ts). A fixture
 * that injects a `turn` field onto events proves nothing about production: the
 * first fix round keyed on such a field, `createEvent` never sets one, so in
 * production `currentTurn` was always `undefined` and the exclusion collected
 * nothing — `page: true` re-returned the same top-k on every dispatch, the
 * #926 behaviour the feature exists to fix, silently.
 *
 * Every fixture here is built by `createEvent` itself — the `user_message`
 * exactly as `createContext` writes it, the retriever `tool_result` exactly as
 * `emitMatches` writes it through `trackEvent` — so "no `turn` field anywhere"
 * holds by construction, and the pins hold only if the scoping derives the
 * boundary from the stream.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

import { retriever } from '../../patterns/retriever.server'
import { createEvent, createScope } from '../../context.server'
import { createEventView } from '../../patterns/event-view.server'
import type { RetrievalHit, RetrieverResult } from '../../patterns/retriever.server'
import type { ContextEvent } from '../../types'

type Data = Record<string, unknown>

const hit = (docId: string, chunkIndex: number): RetrievalHit => ({
  backend: 'redis',
  id: `${docId}:${chunkIndex}`,
  content: `chunk ${chunkIndex} of ${docId}`,
  source: `${docId}.txt`,
  docId,
  chunkIndex,
  startOffset: chunkIndex * 10,
  endOffset: chunkIndex * 10 + 10,
  docChunks: 84,
})

const retrieverResult = (matches: RetrievalHit[]): RetrieverResult => ({
  query: 'q',
  backends: ['redis'],
  matches,
  references: [],
})

/** The turn's `user_message`, built by `createEvent` — byte-for-byte the event
 *  `createContext` pushes (id, ts, `patternId: 'harness'`, `{ content }`). */
const userMessage = (text: string): ContextEvent =>
  createEvent('user_message', 'harness', { content: text })

/** A finished retriever dispatch's `tool_result`, built by `createEvent` — the
 *  event `emitMatches` writes through `trackEvent` (tool, result, success,
 *  summary). `patternId` is the route's own pattern, as a decision-loop child
 *  records it. */
const resultEvent = (patternId: string): ContextEvent =>
  createEvent('tool_result', patternId, {
    tool: 'retriever',
    success: true,
    summary: '2 match(es) from redis',
    result: retrieverResult([hit('a', 0), hit('a', 1)]),
  })

/** Drive the real retriever `fn` over `events` and hand back the opts bag the
 *  backend's `search` received. */
const run = async (events: ContextEvent[], page: boolean) => {
  const search = vi.fn(async (_q: { text: string }, opts: { k: number; excludeIds?: string[] }) => {
    void opts
    return [hit('a', 5), hit('a', 6), hit('a', 7), hit('a', 8), hit('a', 9)]
  })
  const pattern = retriever<Data>({
    patternId: 'retriever',
    backends: [{ name: 'redis', type: 'vector', search }],
    // `generateQuery: false`: the raw last user message is the query, so no
    // rewrite fn is ever called. `rewrite` is a required field regardless.
    rewrite: vi.fn() as never,
    generateQuery: false,
    ...(page ? { page: true } : {}),
  })
  const ctx = { events } as unknown as Parameters<typeof createEventView>[0]
  await pattern.fn(createScope<Data>('retriever', {}), createEventView(ctx, undefined, 'retriever'))
  return search.mock.calls[0]![1]
}

describe('retriever page: true — production-shaped events (no `turn` field anywhere)', () => {
  it('a same-turn earlier result is STILL excluded when events carry no turn field', async () => {
    // One turn: its user_message, then this route's own earlier dispatch — the
    // #926 shape: a re-dispatch of the same route must advance past page 1.
    const opts = await run(
      [userMessage('what does the document say?'), resultEvent('retriever')],
      true,
    )
    expect(opts.excludeIds).toEqual(['a:0', 'a:1'])
  })

  it('an earlier turn result is NOT excluded when events carry no turn field', async () => {
    // Turn 1 retrieved; turn 2 asks a fresh question. The boundary is the LAST
    // user_message: everything before it is an earlier turn, so a fresh turn
    // starts from the top of the document instead of resuming where the last
    // turn left off.
    const opts = await run(
      [
        userMessage('first question'),
        resultEvent('retriever'),
        userMessage('a different question'),
      ],
      true,
    )
    expect(opts.excludeIds).toEqual([])
  })

  it("another route's result is not excluded — the scoping keys on the route, not the tool", async () => {
    // Same turn, but the earlier result was recorded under a different
    // route's patternId: not this route's work, so not excluded.
    const opts = await run([userMessage('q'), resultEvent('other-route')], true)
    expect(opts.excludeIds).toEqual([])
  })

  it('page is opt-in: without it, no exclusion is handed to the backend at all', async () => {
    const opts = await run([userMessage('q'), resultEvent('retriever')], false)
    expect(opts.excludeIds).toBeUndefined()
  })
})
