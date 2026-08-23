/**
 * Tests for the non-agentic Neo4j server functions.
 *
 * The driver module is mocked, so these exercise the contract the UI relies on:
 * every function resolves to a `{ success }` envelope instead of throwing, and
 * the session is always closed.
 *
 * Since #230 they also pin the two security properties of this module: every
 * `'use server'` export refuses an unauthenticated caller before the driver is
 * touched, and every session is a READ-mode one, so the driver — not a keyword
 * blacklist — is what makes the caller-supplied query read-only.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const run = vi.fn()
const close = vi.fn().mockResolvedValue(undefined)
// `runManualCypher` goes through a managed read transaction; every other read
// is an auto-commit `session.run`. Both land on the same `run` mock.
const executeRead = vi.fn((work: (tx: { run: typeof run }) => unknown) => work({ run }))
const session = vi.fn((_config?: { defaultAccessMode?: string }) => ({
  run,
  close,
  executeRead,
}))
const resetDriver = vi.fn().mockResolvedValue(undefined)
const verifyConnection = vi.fn().mockResolvedValue(true)

vi.mock('../../../lib/neo4j/client', () => ({
  getNeo4jDriver: () => ({ session }),
  resetDriver: () => resetDriver(),
  verifyConnection: () => verifyConnection(),
}))

const getAuthenticatedUser = vi.fn(async () => ({ id: 'user-a', email: 'a@example.com' }))
vi.mock('../../../lib/auth/server', () => ({
  getAuthenticatedUser: () => getAuthenticatedUser(),
}))

// Pinned off by default: the local `.env` may enable the dev bypass, and these
// tests are about the real gate. One test below turns it on deliberately.
const isBypassEnabled = vi.fn(() => false)
vi.mock('../../../lib/auth/dev-bypass', () => ({
  isBypassEnabled: () => isBypassEnabled(),
  BYPASS_USER: { id: 'dev-bypass-user', email: 'dev@local' },
}))

import * as queries from '../../../lib/neo4j/queries'
import {
  getSchema,
  getSchemaForAgent,
  getSimplifiedSchema,
  getNodeProperties,
  runManualCypher,
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

const queriesSource = () =>
  readFileSync(path.resolve(process.cwd(), 'src/lib/neo4j/queries.ts'), 'utf8')

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  run.mockReset()
  close.mockClear()
  session.mockClear()
  executeRead.mockClear()
  resetDriver.mockClear().mockResolvedValue(undefined)
  verifyConnection.mockClear().mockResolvedValue(true)
  getAuthenticatedUser.mockClear().mockResolvedValue({ id: 'user-a', email: 'a@example.com' })
  isBypassEnabled.mockClear().mockReturnValue(false)
})

// The RPC surface of this module, as the browser sees it: name → a call with
// valid arguments. Used by the auth-gate suite so a new export cannot be added
// without deciding how it is gated.
const RPCS: Array<[string, () => Promise<{ success: boolean; error?: string }>]> = [
  ['getSchema', () => getSchema()],
  ['getSchemaForAgent', () => getSchemaForAgent()],
  ['getSimplifiedSchema', () => getSimplifiedSchema()],
  ['getNodeProperties', () => getNodeProperties('4:abc:1')],
  ['runManualCypher', () => runManualCypher('MATCH (n) RETURN n')],
  ['resetNeo4jConnection', () => resetNeo4jConnection()],
  ['testNeo4jConnection', () => testNeo4jConnection()],
]

describe('auth gate (#230)', () => {
  it.each(RPCS)('%s refuses an unauthenticated caller before touching Neo4j', async (_n, call) => {
    getAuthenticatedUser.mockRejectedValue(
      new Error('Authentication required: No user found in session.'),
    )

    const res = await call()

    // Envelope, not a throw — the UI shows `error` verbatim.
    expect(res).toEqual({
      success: false,
      error: 'Authentication required: No user found in session.',
    })
    expect(session).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
    expect(resetDriver).not.toHaveBeenCalled()
    expect(verifyConnection).not.toHaveBeenCalled()
  })

  it.each(RPCS)('%s refuses a caller outside the email allow-list', async (_n, call) => {
    getAuthenticatedUser.mockRejectedValue(new Error('Email not allowed: intruder@evil.test'))

    expect(await call()).toEqual({ success: false, error: 'Email not allowed: intruder@evil.test' })
    expect(session).not.toHaveBeenCalled()
  })

  it('stringifies a non-Error auth rejection rather than leaking `undefined`', async () => {
    getAuthenticatedUser.mockRejectedValue('session store unreachable')

    expect(await runManualCypher('MATCH (n) RETURN n')).toEqual({
      success: false,
      error: 'session store unreachable',
    })
    expect(session).not.toHaveBeenCalled()
  })

  it('consults the authenticated user on every call, and runs when it resolves', async () => {
    run.mockResolvedValue(results([]))
    await getSchema()
    expect(getAuthenticatedUser).toHaveBeenCalledTimes(1)
    expect(session).toHaveBeenCalledTimes(1)
  })

  it('honours the DEV-gated dev bypass without consulting the session', async () => {
    isBypassEnabled.mockReturnValue(true)
    getAuthenticatedUser.mockRejectedValue(new Error('Authentication required'))
    run.mockResolvedValue(results([]))

    expect((await getSchema()).success).toBe(true)
    expect(getAuthenticatedUser).not.toHaveBeenCalled()
  })
})

describe('read-only at the driver (#230)', () => {
  it('opens every session in READ access mode', async () => {
    run.mockResolvedValue(results([]))

    await getSchema()
    await getSchemaForAgent()
    await getSimplifiedSchema()
    await getNodeProperties('4:abc:1')
    await runManualCypher('MATCH (n) RETURN n')

    expect(session).toHaveBeenCalledTimes(5)
    for (const call of session.mock.calls) {
      expect(call[0]).toEqual({ defaultAccessMode: 'READ' })
    }
  })

  it('runs the caller-supplied query inside a managed read transaction', async () => {
    run.mockResolvedValue(results([]))
    await runManualCypher('MATCH (n) RETURN n')

    expect(executeRead).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith('MATCH (n) RETURN n')
  })

  it('surfaces the driver refusing a write that got past the keyword pre-check', async () => {
    // A write smuggled past WRITE_CLAUSE — no boundary-delimited keyword in
    // sight. The READ transaction is what stops it, and the server says so.
    run.mockRejectedValue(
      new Error('Neo.ClientError.Statement.AccessMode: Writing in read access mode not allowed'),
    )

    const res = await runManualCypher('CALL apoc.cypher.doIt("CR" + "EATE (n)", {})')

    expect(res.success).toBe(false)
    expect(res.error).toContain('read-only')
    expect(res.error).toContain('Writing in read access mode not allowed')
    expect(close).toHaveBeenCalledTimes(1)
  })
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

  // Replaces the BUG(#190) pin that used to live here: the guard was a plain
  // substring match, so any identifier merely *containing* a write keyword was
  // refused with a message naming a clause the query never used. It matches on
  // word boundaries now (and it is no longer the actual write barrier — the
  // READ-mode transaction is), so these are reads and they run.
  it.each([
    'MATCH (n) RETURN n.createdAt',
    'MATCH (n) WHERE n.deleted IS NULL RETURN n',
    'MATCH (n:Dataset) RETURN n',
    'MATCH (n) RETURN n.mergedBy',
  ])('runs the read query %s, whose identifiers contain write keywords', async (query) => {
    run.mockResolvedValue(results([]))

    const res = await runManualCypher(query)

    expect(res.success).toBe(true)
    expect(run).toHaveBeenCalledWith(query)
  })

  it('returns the query error as data and closes the session', async () => {
    run.mockRejectedValue(new Error('SyntaxError: bad cypher'))
    const res = await runManualCypher('MATCH (n RETURN n')
    expect(res).toEqual({ success: false, error: 'SyntaxError: bad cypher' })
    expect(close).toHaveBeenCalledTimes(1)
  })
})

// Regression pin for #228: `executeWriteCypher(cypher)` was a `'use server'`
// export here — browser-reachable, unauthenticated, and it ran whatever string
// it was handed. It is gone; graph writes go through the intent-shaped,
// authenticated ops in `graph-edit.server.ts` (pinned by graph-edit.test.ts).
// Re-adding any raw-Cypher write RPC to this module fails these.
describe('no arbitrary-Cypher write RPC (#228)', () => {
  it('is not exported from the module or the barrel', async () => {
    const barrel = await import('../../../lib/neo4j')
    expect(Object.keys(queries)).not.toContain('executeWriteCypher')
    expect(Object.keys(barrel)).not.toContain('executeWriteCypher')
  })

  it('runManualCypher is the only export that hands caller-supplied text to the driver', () => {
    const source = queriesSource()
    // Every other query in this file is a literal the module owns; only the
    // manual-query path takes its text from the caller, and it reaches the
    // driver through a managed READ transaction.
    expect(source.match(/\.run\(cypher\b/g)).toHaveLength(1)
    const afterManual = source.slice(source.indexOf('export async function runManualCypher'))
    expect(afterManual).toContain('session.executeRead((tx) => tx.run(cypher))')
  })
})

// Class pins for #230, held on the source rather than on one symbol: adding an
// export that skips the auth gate, or one that opens a write-capable session,
// fails here even if it never appears in a behavioural test.
describe('every RPC in this module is gated and read-only (#230)', () => {
  it('has exactly one driver.session() call site, and it pins READ access mode', () => {
    const source = queriesSource()
    expect(source.match(/\.session\(/g)).toHaveLength(1)
    expect(source).toContain('defaultAccessMode: neo4j.session.READ')
    expect(source).toContain('function readSession()')
  })

  it('gates every exported server function on denyUnauthenticated()', () => {
    const source = queriesSource()
    const exported = source.match(/^export async function /gm) ?? []
    const gated = source.match(/^ {2}const denied = await denyUnauthenticated\(\)$/gm) ?? []

    expect(exported.length).toBeGreaterThan(0)
    expect(gated).toHaveLength(exported.length)
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
