/**
 * Intent-shaped graph edit actions (#226 C2).
 *
 * Replaces write-action.test.ts: the arbitrary-Cypher RPC is gone, so these
 * pin the new contract — every operation requires an authenticated user,
 * owns its Cypher (values ride as parameters), rejects identifiers that
 * could smuggle query syntax, and closes the session even on failure.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const sessionRun = vi.fn(async (..._a: unknown[]) => ({ records: [] as unknown[] }))
const sessionClose = vi.fn(async () => undefined)
const driverSession = vi.fn(() => ({ run: sessionRun, close: sessionClose }))

vi.mock('../../../lib/neo4j/client', () => ({
  getNeo4jDriver: () => ({ session: driverSession }),
}))

const getAuthenticatedUser = vi.fn(async () => ({ id: 'user-a' }))
vi.mock('../../../lib/auth/server', () => ({
  getAuthenticatedUser: () => getAuthenticatedUser(),
}))

const lastCypher = () => String(sessionRun.mock.calls.at(-1)![0])
const lastParams = () => sessionRun.mock.calls.at(-1)![1]

const repo = () => import('../../../lib/neo4j/graph-edit.server')

beforeEach(() => {
  vi.clearAllMocks()
  getAuthenticatedUser.mockResolvedValue({ id: 'user-a' })
  // The gate is `isBypassEnabled() || getAuthenticatedUser()`, and the first
  // half reads `import.meta.env.VITE_DEV_BYPASS_AUTH` at call time — so a
  // developer running with the bypass on in their own `.env` used to turn the
  // rejection case below green-while-asserting-nothing on their machine and
  // red nowhere. Pinned here rather than left to the environment: what these
  // tests are about is the gate, so the gate's inputs are inputs of the test.
  vi.stubEnv('VITE_DEV_BYPASS_AUTH', 'false')
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('auth gate', () => {
  it('rejects an unauthenticated caller on every operation, before touching the driver', async () => {
    getAuthenticatedUser.mockRejectedValue(
      new Error('Authentication required: No user found in session.'),
    )
    const { createGraphNode, linkGraphNodes, setGraphNodeProperty } = await repo()

    await expect(createGraphNode('Concept', 'GraphQL')).rejects.toThrow('Authentication required')
    await expect(linkGraphNodes('Alpha', 'Beta', 'RELATES_TO')).rejects.toThrow(
      'Authentication required',
    )
    await expect(setGraphNodeProperty('Alpha', 'summary', 'v')).rejects.toThrow(
      'Authentication required',
    )
    expect(driverSession).not.toHaveBeenCalled()
  })

  it('is bypassed by the dev flag — which is what makes the pin above load-bearing', async () => {
    // Without this case the `stubEnv` above could stop reaching
    // `isBypassEnabled()` entirely and nothing would notice: the rejection case
    // passes on any machine that simply has no bypass set. Here the stub is the
    // only thing that can produce the behaviour, so a pin that stopped working
    // fails rather than silently reverting the test to environment-dependent.
    vi.stubEnv('VITE_DEV_BYPASS_AUTH', 'true')
    getAuthenticatedUser.mockRejectedValue(new Error('Authentication required: no session.'))
    const { createGraphNode } = await repo()

    await expect(createGraphNode('Concept', 'GraphQL')).resolves.toBeUndefined()
    expect(driverSession).toHaveBeenCalled()
  })
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
  it('creates a node with description, values as parameters', async () => {
    const { createGraphNode } = await repo()

    await createGraphNode('Concept', 'GraphQL', 'A query language')

    expect(lastCypher()).toBe('CREATE (n:`Concept` {name: $name, description: $description})')
    expect(lastParams()).toEqual({ name: 'GraphQL', description: 'A query language' })
    expect(sessionClose).toHaveBeenCalledTimes(1)
  })

  it('omits the description clause when none is given', async () => {
    const { createGraphNode } = await repo()

    await createGraphNode('Concept', 'REST')

    expect(lastCypher()).toBe('CREATE (n:`Concept` {name: $name})')
    expect(lastParams()).toEqual({ name: 'REST' })
  })
})

describe('linkGraphNodes', () => {
  it('creates a typed edge between name-matched nodes (the normal UI path)', async () => {
    const { linkGraphNodes } = await repo()

    await linkGraphNodes('Alpha', 'Beta', 'DEPENDS_ON')

    expect(lastCypher()).toBe(
      'MATCH (a {name: $sourceName}), (b {name: $targetName}) CREATE (a)-[:`DEPENDS_ON`]->(b)',
    )
    expect(lastParams()).toEqual({ sourceName: 'Alpha', targetName: 'Beta' })
    expect(sessionClose).toHaveBeenCalledTimes(1)
  })

  it('node names are parameters — a hostile name cannot reach the query text', async () => {
    const { linkGraphNodes } = await repo()

    const hostile = `"}) MATCH (n) DETACH DELETE n //`
    await linkGraphNodes(hostile, 'Beta', 'RELATES_TO')

    expect(lastCypher()).not.toContain('DETACH')
    expect(lastParams()).toEqual({ sourceName: hostile, targetName: 'Beta' })
  })
})

describe('setGraphNodeProperty', () => {
  it('sets one property, key backtick-quoted, value as a parameter', async () => {
    const { setGraphNodeProperty } = await repo()

    await setGraphNodeProperty('Alpha', 'summary', 'new summary')

    expect(lastCypher()).toBe('MATCH (n {name: $name}) SET n.`summary` = $value')
    expect(lastParams()).toEqual({ name: 'Alpha', value: 'new summary' })
  })

  it('closes the session even when the query throws', async () => {
    sessionRun.mockRejectedValueOnce(new Error('neo4j down'))
    const { setGraphNodeProperty } = await repo()

    await expect(setGraphNodeProperty('Alpha', 'summary', 'v')).rejects.toThrow('neo4j down')
    expect(sessionClose).toHaveBeenCalledTimes(1)
  })
})
