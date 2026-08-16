/**
 * reference-extractor — pulls the retriever's typed references out of the event
 * stream (client-safe; mirrors graph-extractor). Types are erased at runtime, so
 * this exercises the pure extraction logic with plain event objects.
 */
import { describe, it, expect } from 'vitest'
import { extractReferences, referencesForDoc } from '../../lib/harness-client/reference-extractor'
import type { ContextEvent, RetrievalReference } from '../../lib/harness-patterns'

function retrieverResult(references: RetrievalReference[]): ContextEvent {
  return {
    type: 'tool_result',
    ts: 1,
    patternId: 'retriever',
    data: { tool: 'retriever', success: true, result: { query: 'q', backends: ['redis'], matches: [], references } },
  } as unknown as ContextEvent
}

const ref = (docId: string, source: string, startOffset: number, endOffset: number, chunkIndex = 0): RetrievalReference => ({
  source,
  docId,
  chunkIndex,
  startOffset,
  endOffset,
})

describe('extractReferences', () => {
  it('returns [] when there is no retriever tool_result', () => {
    const events = [
      { type: 'user_message', ts: 1, patternId: 'h', data: { content: 'hi' } },
      { type: 'tool_result', ts: 2, patternId: 'neo4j-query', data: { tool: 'read_neo4j_cypher', success: true, result: {} } },
    ] as unknown as ContextEvent[]
    expect(extractReferences(events)).toEqual([])
  })

  it('pulls references from the retriever tool_result', () => {
    const refs = [ref('d1', 'a.md', 0, 10), ref('d2', 'b.md', 5, 20)]
    expect(extractReferences([retrieverResult(refs)])).toEqual(refs)
  })

  it('uses the MOST RECENT retriever result across turns', () => {
    const older = retrieverResult([ref('d1', 'old.md', 0, 5)])
    const newer = retrieverResult([ref('d2', 'new.md', 0, 5)])
    const events = [older, { type: 'user_message', ts: 3, patternId: 'h', data: { content: 'q2' } }, newer] as unknown as ContextEvent[]
    expect(extractReferences(events)).toEqual([ref('d2', 'new.md', 0, 5)])
  })

  it('ignores non-retriever tool_results', () => {
    const events = [
      { type: 'tool_result', ts: 1, patternId: 'web', data: { tool: 'search', success: true, result: { hits: [] } } },
    ] as unknown as ContextEvent[]
    expect(extractReferences(events)).toEqual([])
  })

  it('tolerates a retriever result with no references field', () => {
    const bad = { type: 'tool_result', ts: 1, patternId: 'retriever', data: { tool: 'retriever', success: true, result: { query: 'q' } } } as unknown as ContextEvent
    expect(extractReferences([bad])).toEqual([])
  })
})

describe('referencesForDoc', () => {
  it('filters to one doc and sorts by start offset', () => {
    const events = [
      retrieverResult([
        ref('d1', 'a.md', 40, 60, 2),
        ref('d2', 'b.md', 0, 10),
        ref('d1', 'a.md', 0, 12, 0),
        ref('d1', 'a.md', 20, 30, 1),
      ]),
    ]
    const out = referencesForDoc(events, 'd1')
    expect(out.map((r) => r.startOffset)).toEqual([0, 20, 40])
    expect(out.every((r) => r.docId === 'd1')).toBe(true)
  })

  it('returns [] for a doc with no references', () => {
    expect(referencesForDoc([retrieverResult([ref('d1', 'a.md', 0, 5)])], 'ghost')).toEqual([])
  })
})
