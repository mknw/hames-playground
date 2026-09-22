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

    await expect(createGraphNode('Concept', 'GraphQL')).resolves.toBe('4:abc:99')
    expect(ops.createGraphNode).toHaveBeenCalledWith('Concept', 'GraphQL', undefined)
  })

  it('delegates each op with its caller arguments', async () => {
    const { linkGraphNodes, setGraphNodeProperty } = await repo()

    await linkGraphNodes('4:abc:11', '4:abc:12', 'DEPENDS_ON')
    expect(ops.linkGraphNodes).toHaveBeenCalledWith('4:abc:11', '4:abc:12', 'DEPENDS_ON')

    await setGraphNodeProperty('4:abc:11', 'summary', 'v')
    expect(ops.setGraphNodeProperty).toHaveBeenCalledWith('4:abc:11', 'summary', 'v')
  })
})
