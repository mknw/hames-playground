/**
 * #927 slice 1 + fix round 2 rendering pins: the documents block's `N chunks`
 * and the retriever step line's `k of N chunks seen`.
 *
 * The step line's `k` is `RouteStats.seen` — CUMULATIVE for the turn (#927's
 * worked example: "5 new matches, 10 of 84 chunks seen this turn"), this
 * dispatch's matches plus the same route's earlier records this turn, so a
 * later dispatch reads how much of the document remains, not just its own
 * page. `computeStats` accumulates it over the same-route records it is
 * handed; `formatStats` renders it beside the combined total of the matched
 * documents — only when every one of them reported a count, so a legacy
 * document renders no count, never a fabricated 0.
 *
 * The documents-block pins for the same slice live in the app suite's
 * decisionLoop-documents tests, beside the existing `renderDocumentsBlock`
 * pins — never under this package (the zero-app-imports pin).
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

import { createEvent } from '../context.server'
import {
  computeStats,
  formatStats,
  type RouteOutput,
} from '../patterns/decisionLoop-records.server'
import type { ContextEvent } from '../types'

const base = {
  kind: 'retriever' as const,
  toolCalls: 1,
  succeededCalls: 1,
  errors: 0,
  wallMs: 1_000,
  hitBound: false,
}

/** A retriever `tool_result` whose every hit names the same 84-chunk doc. */
const resultEvent = (patternId: string, n: number): ContextEvent =>
  createEvent('tool_result', patternId, {
    tool: 'retriever',
    success: true,
    summary: `${n} match(es) from stash`,
    result: {
      query: 'q',
      backends: ['stash'],
      matches: Array.from({ length: n }, (_, i) => ({
        backend: 'stash',
        id: `a:${i}`,
        content: `chunk ${i}`,
        source: 'a.txt',
        docId: 'a',
        chunkIndex: i,
        startOffset: i * 10,
        endOffset: i * 10 + 10,
        docChunks: 84,
      })),
      references: [],
    },
  })

/** An earlier record of `route` that saw `matches` chunks this turn. */
const earlierRecord = (route: string, matches: number): RouteOutput => ({
  iteration: 1,
  route,
  status: 'succeeded',
  stats: { ...base, matches, seen: matches, documents: 1, backends: ['stash'], chunks: 84 },
  result: 'read',
  reasoning: '',
})

describe('computeStats — the retriever’s `seen` accumulates for the turn (#927)', () => {
  it('a first dispatch’s `seen` is its own matches', () => {
    const s = computeStats('retriever', [resultEvent('read-documents', 5)], 'read-documents', 100)
    expect(s).toMatchObject({ matches: 5, seen: 5, documents: 1, chunks: 84 })
  })

  // MUTATION: drop the same-route accumulation (`seen = matches.length`) →
  // dispatch 2 reads `seen: 5` again and this pin fails.
  it('a second dispatch’s `seen` adds the same route’s earlier records this turn', () => {
    const s = computeStats('retriever', [resultEvent('read-documents', 5)], 'read-documents', 100, [
      earlierRecord('read-documents', 5),
    ])
    expect(s.seen).toBe(10)
  })

  // The same-route FILTER (`r.route === label`) lives in `recordOf`,
  // `decisionLoop.server.ts` — pinned end-to-end by the app suite
  // (`decisionLoop.test.ts`, "the retriever’s cumulative `k of N chunks seen`").
})

describe('retriever step line — k of N chunks seen (#927)', () => {
  it('renders `(5 of 84 chunks seen)` when the total is known', () => {
    const line = formatStats({
      ...base,
      matches: 5,
      seen: 5,
      documents: 1,
      backends: ['redis'],
      chunks: 84,
    })
    expect(line).toContain('(5 of 84 chunks seen)')
  })

  // The #927 worked example: dispatch 2 reads the cumulative `(10 of 84)`,
  // not its own `(5 of 84)`.
  it('renders the cumulative `seen`, not this dispatch’s matches', () => {
    const line = formatStats({
      ...base,
      matches: 5,
      seen: 10,
      documents: 1,
      backends: ['redis'],
      chunks: 84,
    })
    expect(line).toContain('(10 of 84 chunks seen)')
    expect(line).toContain('retriever: 5 matches in 1 document')
  })

  // MUTATION: render the suffix unconditionally → this pin fails.
  it('no recorded total renders no `chunks seen` suffix, never a fabricated 0', () => {
    const line = formatStats({ ...base, matches: 5, seen: 5, documents: 1, backends: ['redis'] })
    expect(line).not.toContain('chunks seen')
  })
})
