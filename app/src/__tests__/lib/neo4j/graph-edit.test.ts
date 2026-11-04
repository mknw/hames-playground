// @vitest-environment node
/**
 * Intent-shaped graph edit WRAPPER tests (#226 C2 / #225 PR-C2).
 *
 * The op bodies moved into `@hames-ai/connectors`; this module's tests pin the
 * RETAINED `'use server'` wrapper's own contract — every operation requires
 * an authenticated user (or the gated dev bypass) before the package op is
 * touched. The ops' identifier validation and Cypher ownership are pinned
 * co-located in the package.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const ops = vi.hoisted(() => ({
  createGraphNode: vi.fn(async () => '4:abc:99'),
  linkGraphNodes: vi.fn(async () => undefined),
  setGraphNodeProperty: vi.fn(async () => undefined),
}))
vi.mock('@hames-ai/connectors/neo4j/graph-edit.server', () => ops)

const getAuthenticatedUser = vi.fn(async () => ({ id: 'user-a' }))
vi.mock('../../../lib/auth/server', () => ({
  getAuthenticatedUser: () => getAuthenticatedUser(),
}))

const repo = () => import('../../../lib/neo4j/graph-edit.server')
const ontology = async () => (await import('../../../lib/org-graph/ontology')).ORG_ONTOLOGY
/** The actor the wrapper reads after its gate: the session user's id. */
const actorFor = (userId: string) => ({ userId, now: expect.any(String) })

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
  it('rejects an unauthenticated caller on every operation, before touching the ops', async () => {
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
    for (const op of Object.values(ops)) {
      expect(op).not.toHaveBeenCalled()
    }
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

    await expect(createGraphNode('Project', 'Heron')).resolves.toBe('4:abc:99')
    const { BYPASS_USER } = await import('../../../lib/auth/dev-bypass')
    expect(ops.createGraphNode).toHaveBeenCalledWith(
      await ontology(),
      actorFor(BYPASS_USER.id),
      'Project',
      'Heron',
      undefined,
    )
  })

  // Design pin (slice 6): createdBy is the session user. Mutation: omit the
  // actor (or pass a constant) → the ops are not called with the session's id.
  it('delegates each op with the ontology, the session user as actor, and its caller arguments', async () => {
    const { createGraphNode, linkGraphNodes, setGraphNodeProperty } = await repo()
    const o = await ontology()

    await createGraphNode('Project', 'Heron', 'A workstream')
    expect(ops.createGraphNode).toHaveBeenCalledWith(
      o,
      actorFor('user-a'),
      'Project',
      'Heron',
      'A workstream',
    )

    await linkGraphNodes('4:abc:11', '4:abc:12', 'WORKS_ON')
    expect(ops.linkGraphNodes).toHaveBeenCalledWith(
      o,
      actorFor('user-a'),
      '4:abc:11',
      '4:abc:12',
      'WORKS_ON',
    )

    getAuthenticatedUser.mockResolvedValue({ id: 'user-b' })
    await setGraphNodeProperty('4:abc:11', 'status', 'v')
    expect(ops.setGraphNodeProperty).toHaveBeenCalledWith(
      o,
      actorFor('user-b'),
      '4:abc:11',
      'status',
      'v',
    )
  })
})
