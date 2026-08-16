/**
 * Tests for `enrichNeo4jResult`.
 *
 * Focus: the rel-direction canonicalization. The enricher must always emit the
 * 3-tuple in the relationship's actual direction (rel.start → rel.end), not
 * the query binding order. Otherwise the same edge gets two different IDs
 * depending on which side the agent's query touched first, and the panel
 * shows duplicate edges (user-reported bug).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

const sessionRun = vi.fn()
const sessionClose = vi.fn().mockResolvedValue(undefined)
const driverSession = vi.fn(() => ({ run: sessionRun, close: sessionClose }))

vi.mock('../../../lib/neo4j/client', () => ({
  getNeo4jDriver: () => ({ session: driverSession }),
}))

// Driver-shaped mocks. `identity` is a plain string here — the enricher's
// `identityEquals` falls back to `String(a) === String(b)` for non-Integer
// values, so this matches behaviour against real `neo4j.Integer`.
const node = (identity: string, name: string) => ({
  identity,
  labels: ['Concept'],
  properties: { name },
})

const rel = (startId: string, endId: string, type: string) => ({
  type,
  start: startId,
  end: endId,
  properties: {},
})

const record = (n: unknown, r: unknown, m: unknown) => ({
  get(field: string) {
    return field === 'n' ? n : field === 'r' ? r : m
  },
})

beforeEach(() => {
  vi.clearAllMocks()
  sessionClose.mockResolvedValue(undefined)
})

describe('enrichNeo4jResult — canonical edge direction', () => {
  it('emits rel tuple in start→end order when n is the rel start', async () => {
    const { enrichNeo4jResult } = await import('../../../lib/harness-client/neo4j-enricher.server')

    sessionRun.mockResolvedValueOnce({
      records: [
        record(
          node('redis-id', 'Redis'),
          rel('redis-id', 'kvdb-id', 'CAN_BE'),
          node('kvdb-id', 'Key-Value Database'),
        ),
      ],
    })

    const out = await enrichNeo4jResult(
      'read_neo4j_cypher',
      { success: true, data: [{ c: { name: 'Redis' } }] },
      { args: {} },
    )

    expect(out).toBeDefined()
    const payload = (out as { data: { _neighborhood: { rows: Array<{ r: unknown }> } } }).data
    const tuple = payload._neighborhood.rows[0].r as [{ name: string }, string, { name: string }]
    expect(tuple[0].name).toBe('Redis')
    expect(tuple[1]).toBe('CAN_BE')
    expect(tuple[2].name).toBe('Key-Value Database')
  })

  it('FLIPS rel tuple to start→end when n is the rel end (the dup-edge fix)', async () => {
    const { enrichNeo4jResult } = await import('../../../lib/harness-client/neo4j-enricher.server')

    // Same physical relationship, but this time the agent's query touched
    // KVDB first — so n=KVDB but the rel still goes Redis -> KVDB.
    sessionRun.mockResolvedValueOnce({
      records: [
        record(
          node('kvdb-id', 'Key-Value Database'),
          rel('redis-id', 'kvdb-id', 'CAN_BE'),
          node('redis-id', 'Redis'),
        ),
      ],
    })

    const out = await enrichNeo4jResult(
      'read_neo4j_cypher',
      { success: true, data: [{ c: { name: 'Key-Value Database' } }] },
      { args: {} },
    )

    const payload = (out as { data: { _neighborhood: { rows: Array<{ r: unknown }> } } }).data
    const tuple = payload._neighborhood.rows[0].r as [{ name: string }, string, { name: string }]
    // Must canonicalize to the rel's actual direction, NOT the query binding order.
    expect(tuple[0].name).toBe('Redis')
    expect(tuple[1]).toBe('CAN_BE')
    expect(tuple[2].name).toBe('Key-Value Database')
  })

  it('skips enrichment when no node names are present in the result', async () => {
    const { enrichNeo4jResult } = await import('../../../lib/harness-client/neo4j-enricher.server')

    const out = await enrichNeo4jResult(
      'read_neo4j_cypher',
      { success: true, data: [{ count: 42 }] }, // no `name` anywhere
      { args: {} },
    )

    expect(out).toBeUndefined()
    expect(sessionRun).not.toHaveBeenCalled()
  })

  it('skips non-enrichable tools', async () => {
    const { enrichNeo4jResult } = await import('../../../lib/harness-client/neo4j-enricher.server')

    const out = await enrichNeo4jResult(
      'get_neo4j_schema',
      { success: true, data: { Concept: { type: 'node', count: 1 } } },
      { args: {} },
    )

    expect(out).toBeUndefined()
    expect(sessionRun).not.toHaveBeenCalled()
  })
})
