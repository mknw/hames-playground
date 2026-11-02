/**
 * Tests for `enrichNeo4jResult`.
 *
 * The neighbourhood is read through the shared tool-call function, the
 * chokepoint where a run's injection guard applies (SD-6): never through a
 * driver session of its own. On a guarded route every name in the agent's
 * read arrives fenced, so the names are read through the fence before they
 * are queried.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FENCE, sanitizeUntrusted } from '@hames-ai/harness-patterns/guard'

const callTool = vi.fn()
vi.mock('@hames-ai/harness-patterns/mcp-client.server', () => ({ callTool }))

const { enrichNeo4jResult } = await import('../../../lib/harness-client/neo4j-enricher.server')

const NEIGHBORHOOD = [
  {
    n: { name: 'Redis' },
    r: [{ name: 'Redis' }, 'HAS_CONCEPT', { name: 'Streams' }],
    m: { name: 'Streams' },
  },
]

beforeEach(() => {
  callTool.mockReset()
  callTool.mockResolvedValue({ success: true, data: NEIGHBORHOOD })
})

describe('enrichNeo4jResult', () => {
  it('reads the neighbourhood through the shared tool-call function, by name', async () => {
    const rows = [{ name: 'Redis', description: 'An in-memory data store.' }]
    const out = await enrichNeo4jResult(
      'read_neo4j_cypher',
      { success: true, data: rows },
      { args: {} },
    )
    expect(callTool).toHaveBeenCalledTimes(1)
    const [tool, args] = callTool.mock.calls[0]
    expect(tool).toBe('read_neo4j_cypher')
    expect(args.query).toContain('WHERE n.name IN $names')
    expect(args.params).toEqual({ names: ['Redis'] })
    expect(out).toEqual({
      data: { rows, _neighborhood: { rows: NEIGHBORHOOD }, _touched: ['Redis'] },
    })
  })

  it('queries the names a guarded route fenced, and keeps them fenced in `_touched`', async () => {
    const rows = sanitizeUntrusted(
      [{ name: 'Redis' }, { n: { name: 'Streams' } }],
      { tool: 'read_neo4j_cypher', namespace: 'neo4j', item: 'call-1' },
      { spotlight: 'always' },
    ).data
    const out = await enrichNeo4jResult(
      'read_neo4j_cypher',
      { success: true, data: rows },
      { args: {} },
    )
    // MUTATION: query `touched` instead of the unfenced names — red here.
    expect(callTool.mock.calls[0][1].params).toEqual({ names: ['Redis', 'Streams'] })
    const touched = (out as { data: { _touched: string[] } }).data._touched
    expect(touched).toHaveLength(2)
    // The hook adds no unfenced graph text to a result the guard fenced.
    expect(touched.every((name) => name.startsWith(FENCE.open))).toBe(true)
  })

  it('a failed neighbourhood read throws, so the loop records it and keeps the rows', async () => {
    callTool.mockResolvedValueOnce({ success: false, data: null, error: 'gateway down' })
    await expect(
      enrichNeo4jResult(
        'read_neo4j_cypher',
        { success: true, data: [{ name: 'Redis' }] },
        {
          args: {},
        },
      ),
    ).rejects.toThrow('neighborhood read failed: gateway down')
  })

  it('skips enrichment when no node names are present in the result', async () => {
    const out = await enrichNeo4jResult(
      'read_neo4j_cypher',
      { success: true, data: [{ count: 42 }] },
      { args: {} },
    )
    expect(out).toBeUndefined()
    expect(callTool).not.toHaveBeenCalled()
  })

  it('skips non-enrichable tools and failed reads', async () => {
    expect(
      await enrichNeo4jResult(
        'get_neo4j_schema',
        { success: true, data: { Concept: { type: 'node', count: 1 } } },
        { args: {} },
      ),
    ).toBeUndefined()
    expect(
      await enrichNeo4jResult(
        'read_neo4j_cypher',
        { success: false, data: null, error: 'bad query' },
        { args: {} },
      ),
    ).toBeUndefined()
    expect(callTool).not.toHaveBeenCalled()
  })
})
