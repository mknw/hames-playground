/**
 * Intent-shaped graph edit OPS (#226 C2) — moved co-located with the module
 * from the host app's `graph-edit.test.ts` (#225 PR-C2).
 *
 * The auth-gate half of the old suite stayed with the host's `'use server'`
 * wrapper (that is what the gate now belongs to); these pin the OPS' own
 * contract — every operation owns its Cypher (values ride as parameters),
 * rejects identifiers that could smuggle query syntax, and closes the
 * session even on failure.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const sessionRun = vi.fn(async (..._a: unknown[]) => ({ records: [] as unknown[] }))

/** Make the mocked session look like it matched `n` rows — the value of the
 *  final `RETURN count(*)` column the ops read to detect a zero match. */
const matchedRows = (n: number) => sessionRun.mockResolvedValueOnce({ records: [{ get: () => n }] })
const sessionClose = vi.fn(async () => undefined)
const driverSession = vi.fn(() => ({ run: sessionRun, close: sessionClose }))

vi.mock('../../neo4j/client', () => ({
  getNeo4jDriver: () => ({ session: driverSession }),
}))

const lastCypher = () => String(sessionRun.mock.calls.at(-1)![0])
const lastParams = () => sessionRun.mock.calls.at(-1)![1]

const repo = () => import('../../neo4j/graph-edit.server')

beforeEach(() => {
  vi.clearAllMocks()
})

describe('identifier validation', () => {
  it('rejects an injected relationship type without running any query', async () => {
    const { linkGraphNodes } = await repo()

    await expect(
      linkGraphNodes('Alpha', 'Beta', 'X]->(b) MATCH (n) DETACH DELETE n //'),
    ).rejects.toThrow(/Invalid relationship type/)
    expect(sessionRun).not.toHaveBeenCalled()
  })

  it('rejects a label that escapes its backtick quoting', async () => {
    const { createGraphNode } = await repo()

    await expect(createGraphNode('X` {a:1}) MATCH (n) DETACH DELETE n //', 'name')).rejects.toThrow(
      /Invalid label/,
    )
    expect(sessionRun).not.toHaveBeenCalled()
  })

  it('rejects a property key with query syntax', async () => {
    const { setGraphNodeProperty } = await repo()

    await expect(setGraphNodeProperty('Alpha', 'k = 1 WITH n MATCH (m)', 'v')).rejects.toThrow(
      /Invalid property key/,
    )
    expect(sessionRun).not.toHaveBeenCalled()
  })
})

describe('createGraphNode', () => {
  it('creates a node with description, values as parameters, and returns its elementId', async () => {
    sessionRun.mockResolvedValueOnce({ records: [{ get: () => '4:abc:99' }] })
    const { createGraphNode } = await repo()

    await expect(createGraphNode('Concept', 'GraphQL', 'A query language')).resolves.toBe(
      '4:abc:99',
    )

    expect(lastCypher()).toBe(
      'CREATE (n:`Concept` {name: $name, description: $description}) RETURN elementId(n) AS elementId',
    )
    expect(lastParams()).toEqual({ name: 'GraphQL', description: 'A query language' })
    expect(sessionClose).toHaveBeenCalledTimes(1)
  })

  it('resolves with the created node\u2019s elementId when no description is given (#323 B1)', async () => {
    sessionRun.mockResolvedValueOnce({ records: [{ get: () => '4:abc:7' }] })
    const { createGraphNode } = await repo()

    await expect(createGraphNode('Concept', 'REST')).resolves.toBe('4:abc:7')
    expect(lastCypher()).toBe('CREATE (n:`Concept` {name: $name}) RETURN elementId(n) AS elementId')
    expect(lastParams()).toEqual({ name: 'REST' })
  })
})

describe('linkGraphNodes', () => {
  it('creates a typed edge between elementId-matched nodes (the normal UI path)', async () => {
    matchedRows(1)
    const { linkGraphNodes } = await repo()

    await linkGraphNodes('4:abc:11', '4:abc:12', 'DEPENDS_ON')

    expect(lastCypher()).toBe(
      'MATCH (a), (b) WHERE elementId(a) = $sourceId AND elementId(b) = $targetId MERGE (a)-[:`DEPENDS_ON`]->(b) RETURN count(*) AS linked',
    )
    expect(lastParams()).toEqual({ sourceId: '4:abc:11', targetId: '4:abc:12' })
    expect(sessionClose).toHaveBeenCalledTimes(1)
  })

  it('node ids are parameters — a hostile id cannot reach the query text', async () => {
    matchedRows(1)
    const { linkGraphNodes } = await repo()

    const hostile = `"}) MATCH (n) DETACH DELETE n //`
    await linkGraphNodes(hostile, '4:abc:12', 'RELATES_TO')

    expect(lastCypher()).not.toContain('DETACH')
    expect(lastParams()).toEqual({ sourceId: hostile, targetId: '4:abc:12' })
  })

  it('rejects when an endpoint matches no node instead of resolving as success (#314)', async () => {
    matchedRows(0)
    const { linkGraphNodes } = await repo()

    await expect(linkGraphNodes('4:abc:404', '4:abc:12', 'RELATES_TO')).rejects.toThrow(
      /no graph node/i,
    )
    expect(sessionClose).toHaveBeenCalledTimes(1)
  })
})

describe('setGraphNodeProperty', () => {
  it('sets one property on the elementId-matched node, key backtick-quoted, value as a parameter', async () => {
    matchedRows(1)
    const { setGraphNodeProperty } = await repo()

    await setGraphNodeProperty('4:abc:11', 'summary', 'new summary')

    expect(lastCypher()).toBe(
      'MATCH (n) WHERE elementId(n) = $nodeId SET n.`summary` = $value RETURN count(n) AS matched',
    )
    expect(lastParams()).toEqual({ nodeId: '4:abc:11', value: 'new summary' })
  })

  it('rejects when the node matches nothing instead of resolving as success (#314)', async () => {
    // A display label that is not a `name` property (e.g. an org-graph GUID)
    // used to issue MATCH ... matching zero nodes and still resolve — the edit
    // reported success and the canvas fabricated the result.
    matchedRows(0)
    const { setGraphNodeProperty } = await repo()

    await expect(setGraphNodeProperty('4:abc:404', 'summary', 'v')).rejects.toThrow(
      /no graph node/i,
    )
    expect(sessionClose).toHaveBeenCalledTimes(1)
  })

  it('closes the session even when the query throws', async () => {
    sessionRun.mockRejectedValueOnce(new Error('neo4j down'))
    const { setGraphNodeProperty } = await repo()

    await expect(setGraphNodeProperty('Alpha', 'summary', 'v')).rejects.toThrow('neo4j down')
    expect(sessionClose).toHaveBeenCalledTimes(1)
  })
})
