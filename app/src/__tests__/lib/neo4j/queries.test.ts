/**
 * Tests for the non-agentic Neo4j server functions.
 *
 * The driver module is mocked, so these exercise the contract the UI relies on:
 * every function resolves to a `{ success }` envelope instead of throwing, and
 * the session is always closed.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const run = vi.fn()
const close = vi.fn().mockResolvedValue(undefined)
const session = vi.fn(() => ({ run, close }))
const resetDriver = vi.fn().mockResolvedValue(undefined)
const verifyConnection = vi.fn().mockResolvedValue(true)

vi.mock('../../../lib/neo4j/client', () => ({
  getNeo4jDriver: () => ({ session }),
  resetDriver: () => resetDriver(),
  verifyConnection: () => verifyConnection(),
}))

import {
  getSchema,
  getSchemaForAgent,
  getSimplifiedSchema,
  getNodeProperties,
  runManualCypher,
  executeWriteCypher,
  resetNeo4jConnection,
  testNeo4jConnection,
} from '../../../lib/neo4j/queries'

/** A stand-in for a driver Record: `get` by key or by positional index. */
const record = (fields: Record<string, unknown>) => {
  const values = Object.values(fields)
  return {
    get: (key: string | number) => (typeof key === 'number' ? values[key] : fields[key]),
    toObject: () => fields,
  }
}

const results = (records: unknown[]) => ({ records })

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  run.mockReset()
  close.mockClear()
  session.mockClear()
  resetDriver.mockClear().mockResolvedValue(undefined)
  verifyConnection.mockClear().mockResolvedValue(true)
})

describe('getSchema', () => {
  it('serialises the visualization records on success', async () => {
    run.mockResolvedValue(results([{ nodes: ['Person'] }]))
    const res = await getSchema()
    expect(res.success).toBe(true)
    expect(JSON.parse(res.schema!)).toEqual([{ nodes: ['Person'] }])
    expect(run).toHaveBeenCalledWith('CALL db.schema.visualization()')
  })

  it('returns the failure as data, and still closes the session', async () => {
    run.mockRejectedValue(new Error('boom'))
    const res = await getSchema()
    expect(res).toEqual({ success: false, error: 'boom' })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('stringifies non-Error throws', async () => {
    run.mockRejectedValue('plain string failure')
    expect((await getSchema()).error).toBe('plain string failure')
  })
})

describe('getSchemaForAgent', () => {
  /** Routes each of the two queries the function issues to its own result. */
  const byQuery = (labels: unknown[], rels: unknown[]) =>
    run.mockImplementation((cypher: string) =>
      Promise.resolve(results(cypher.includes('db.labels()') ? labels : rels)),
    )

  it('renders labels with their properties and relationship patterns', async () => {
    byQuery(
      [record({ label: 'Person', props: ['name', 'age'] })],
      [record({ startLabel: 'Person', relType: 'WORKS_AT', endLabel: 'Company' })],
    )
    const res = await getSchemaForAgent()
    expect(res.success).toBe(true)
    expect(res.schema).toBe(
      'Node Labels:\n' +
        '- Person (properties: name, age)\n' +
        '\nRelationships:\n' +
        '- (Person)-[WORKS_AT]->(Company)\n',
    )
  })

  it('omits the APOC import label and tolerates a label with no properties', async () => {
    byQuery(
      [
        record({ label: 'UNIQUE IMPORT LABEL', props: ['id'] }),
        record({ label: 'Person', props: null }),
      ],
      [],
    )
    const schema = (await getSchemaForAgent()).schema!
    expect(schema).not.toContain('UNIQUE IMPORT LABEL')
    expect(schema).toContain('- Person (properties: )')
  })

  it('drops relationship rows that are missing an endpoint', async () => {
    byQuery(
      [],
      [
        record({ startLabel: 'Person', relType: 'KNOWS', endLabel: null }),
        record({ startLabel: 'Person', relType: 'KNOWS', endLabel: 'Person' }),
      ],
    )
    const schema = (await getSchemaForAgent()).schema!
    expect(schema.match(/^- \(/gm)).toHaveLength(1)
  })

  it('falls back to the simplified schema when the rich queries fail', async () => {
    let call = 0
    run.mockImplementation((cypher: string) => {
      call += 1
      if (call === 1) return Promise.reject(new Error('procedure unavailable'))
      // The fallback issues db.labels / db.relationshipTypes / db.propertyKeys.
      if (cypher.includes('db.labels')) return Promise.resolve(results([record({ v: 'Person' })]))
      if (cypher.includes('db.relationshipTypes'))
        return Promise.resolve(results([record({ v: 'KNOWS' })]))
      return Promise.resolve(results([record({ v: 'name' })]))
    })

    const res = await getSchemaForAgent()
    expect(res.success).toBe(true)
    expect(JSON.parse(res.schema!)).toEqual({
      nodeLabels: ['Person'],
      relationshipTypes: ['KNOWS'],
      propertyKeys: ['name'],
    })
  })
})

describe('getSimplifiedSchema', () => {
  it('collects labels, relationship types and property keys', async () => {
    run.mockImplementation((cypher: string) => {
      if (cypher.includes('db.labels')) return Promise.resolve(results([record({ v: 'Person' })]))
      if (cypher.includes('db.relationshipTypes'))
        return Promise.resolve(results([record({ v: 'KNOWS' })]))
      return Promise.resolve(results([record({ v: 'name' })]))
    })
    const res = await getSimplifiedSchema()
    expect(JSON.parse(res.schema!).nodeLabels).toEqual(['Person'])
  })

  it('surfaces query failures as an error envelope', async () => {
    run.mockRejectedValue(new Error('db down'))
    expect(await getSimplifiedSchema()).toEqual({ success: false, error: 'db down' })
  })
})

describe('getNodeProperties', () => {
  it('returns the properties and labels of the matched node', async () => {
    run.mockResolvedValue(results([record({ props: { name: 'Alice' }, labels: ['Person'] })]))
    const res = await getNodeProperties('4:abc:1')
    expect(res).toEqual({
      success: true,
      properties: { name: 'Alice' },
      labels: ['Person'],
    })
    expect(run).toHaveBeenCalledWith(expect.stringContaining('elementId(n) = $elementId'), {
      elementId: '4:abc:1',
    })
  })

  it('reports a miss rather than an empty node', async () => {
    run.mockResolvedValue(results([]))
    expect(await getNodeProperties('4:abc:9')).toEqual({
      success: false,
      error: 'Node not found',
    })
  })

  it('returns the driver error as data', async () => {
    run.mockRejectedValue(new Error('session expired'))
    expect(await getNodeProperties('x')).toEqual({ success: false, error: 'session expired' })
  })
})

describe('runManualCypher', () => {
  const aliceNode = {
    identity: 1,
    labels: ['Person'],
    properties: { name: 'Alice' },
  }

  it('runs a read query and returns both Cytoscape elements and raw rows', async () => {
    run.mockResolvedValue(results([record({ n: aliceNode })]))
    const res = await runManualCypher('MATCH (n:Person) RETURN n')
    expect(res.success).toBe(true)
    expect(res.graphUpdate).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ id: '1', label: 'Alice' }) }),
    ])
    expect(res.raw).toEqual([{ n: aliceNode }])
  })

  it.each(['CREATE', 'MERGE', 'SET', 'DELETE', 'REMOVE', 'DETACH'])(
    'refuses the %s write keyword without opening a session',
    async (keyword) => {
      const res = await runManualCypher(`${keyword} (n:Person)`)
      expect(res.success).toBe(false)
      expect(res.error).toContain(keyword)
      expect(session).not.toHaveBeenCalled()
    },
  )

  it('is case-insensitive about write keywords', async () => {
    expect((await runManualCypher('create (n)')).success).toBe(false)
  })

  // ⚠️ BUG PIN — issue #190. This is NOT the behaviour we want; it records the
  // behaviour we currently ship, so the false-refusal cannot change unnoticed.
  //
  //   Bug: `runManualCypher`'s write guard is a plain case-insensitive
  //   substring match over the query text, so any identifier that merely
  //   *contains* a write keyword is refused — `n.createdAt` contains 'create',
  //   and a read-only query is rejected with a message naming CREATE.
  //   Also mis-fires on e.g. `n.deleted`, `n.mergedBy`, `n.settings`.
  //
  //   Fix (per #190): match on word boundaries instead of substrings. Applying
  //   that fix makes exactly this test go red — that is the pin working, not a
  //   regression. Whoever lands #190 must DELETE this test and replace it with
  //   the positive: `MATCH (n) RETURN n.createdAt` succeeds while
  //   `CREATE (n)` still refuses. Do not "repair" it by relaxing the assertion.
  it('BUG(#190): rejects a read query whose identifier merely contains a write keyword', async () => {
    const res = await runManualCypher('MATCH (n) RETURN n.createdAt')

    // Refused — and the message names a keyword the query never used, which is
    // what the UI shows the user verbatim.
    expect(res.success).toBe(false)
    expect(res.error).toContain('CREATE')
    // No session is opened, so the false refusal is total, not a partial run.
    expect(session).not.toHaveBeenCalled()
  })

  it('returns the query error as data and closes the session', async () => {
    run.mockRejectedValue(new Error('SyntaxError: bad cypher'))
    const res = await runManualCypher('MATCH (n RETURN n')
    expect(res).toEqual({ success: false, error: 'SyntaxError: bad cypher' })
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe('executeWriteCypher', () => {
  it('runs writes that the manual guard would have refused', async () => {
    run.mockResolvedValue(results([]))
    const res = await executeWriteCypher('CREATE (n:Person {name: "Alice"})')
    expect(res.success).toBe(true)
    expect(res.graphUpdate).toEqual([])
    expect(run).toHaveBeenCalledWith('CREATE (n:Person {name: "Alice"})')
  })

  it('transforms returned nodes into graph elements', async () => {
    run.mockResolvedValue(
      results([record({ n: { identity: 2, labels: ['Person'], properties: { name: 'Bob' } } })]),
    )
    const res = await executeWriteCypher('CREATE (n:Person) RETURN n')
    expect(res.graphUpdate?.[0].data.label).toBe('Bob')
  })

  it('returns the failure as data', async () => {
    run.mockRejectedValue(new Error('constraint violation'))
    expect(await executeWriteCypher('CREATE (n)')).toEqual({
      success: false,
      error: 'constraint violation',
    })
  })
})

describe('connection management', () => {
  it('resets the driver singleton', async () => {
    expect(await resetNeo4jConnection()).toEqual({ success: true })
    expect(resetDriver).toHaveBeenCalledTimes(1)
  })

  it('reports a reset failure instead of throwing', async () => {
    resetDriver.mockRejectedValue(new Error('close failed'))
    expect(await resetNeo4jConnection()).toEqual({ success: false, error: 'close failed' })
  })

  it('reports a healthy connection', async () => {
    expect(await testNeo4jConnection()).toEqual({ success: true, error: undefined })
  })

  it('explains an unhealthy connection', async () => {
    verifyConnection.mockResolvedValue(false)
    expect(await testNeo4jConnection()).toEqual({
      success: false,
      error: 'Connection verification failed',
    })
  })

  it('reports a thrown verification error', async () => {
    verifyConnection.mockRejectedValue(new Error('no route to host'))
    expect(await testNeo4jConnection()).toEqual({
      success: false,
      error: 'no route to host',
    })
  })
})
