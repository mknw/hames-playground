/**
 * Tests for the RETAINED `'use server'` Neo4j wrappers (#225 PR-C2).
 *
 * The op bodies moved into `@hames/connectors`; this module is the thin gated
 * wrapper at the path its clients already import. These tests therefore pin
 * the WRAPPER's contract — every export refuses an unauthenticated caller
 * before the package op is touched, and delegates to it when the gate passes
 * — while the ops' own behaviour is pinned co-located in the package.
 *
 * Since #230 the two security properties of the RPC surface are: every
 * `'use server'` export refuses an unauthenticated caller before any resource
 * is opened, and the wrapper itself opens NO sessions (SD-14: read-only is
 * enforced package-side by the driver's READ access mode, so there is
 * nothing session-shaped here at all — pinned below on the source).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

// The package OPS, mocked: the wrapper's job is only gate + delegate, so the
// op mock is both the witness of delegation and the proof the gate ran first.
const ops = vi.hoisted(() => ({
  getSchema: vi.fn(async () => ({ success: true, schema: 'op:getSchema' })),
  getSchemaForAgent: vi.fn(async () => ({ success: true, schema: 'op:agent' })),
  getSimplifiedSchema: vi.fn(async () => ({ success: true, schema: 'op:simple' })),
  getNodeProperties: vi.fn(async () => ({ success: true, properties: {}, labels: [] })),
  runManualCypher: vi.fn(async () => ({ success: true, raw: [] })),
  resetNeo4jConnection: vi.fn(async () => ({ success: true })),
  testNeo4jConnection: vi.fn(async () => ({ success: true })),
}))
vi.mock('@hames/connectors/neo4j/queries', () => ops)

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

const wrapperSource = () =>
  readFileSync(path.resolve(process.cwd(), 'src/lib/neo4j/queries.ts'), 'utf8')

beforeEach(() => {
  vi.clearAllMocks()
  getAuthenticatedUser.mockResolvedValue({ id: 'user-a', email: 'a@example.com' })
  isBypassEnabled.mockReturnValue(false)
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
  it.each(RPCS)(
    '%s refuses an unauthenticated caller before touching the ops',
    async (_n, call) => {
      getAuthenticatedUser.mockRejectedValue(
        new Error('Authentication required: No user found in session.'),
      )

      const res = await call()

      // Envelope, not a throw — the UI shows `error` verbatim.
      expect(res).toEqual({
        success: false,
        error: 'Authentication required: No user found in session.',
      })
      for (const op of Object.values(ops)) {
        expect(op).not.toHaveBeenCalled()
      }
    },
  )

  it.each(RPCS)('%s refuses a caller outside the email allow-list', async (_n, call) => {
    getAuthenticatedUser.mockRejectedValue(new Error('Email not allowed: intruder@evil.test'))

    expect(await call()).toEqual({ success: false, error: 'Email not allowed: intruder@evil.test' })
    for (const op of Object.values(ops)) {
      expect(op).not.toHaveBeenCalled()
    }
  })

  it('stringifies a non-Error auth rejection rather than leaking `undefined`', async () => {
    getAuthenticatedUser.mockRejectedValue('session store unreachable')

    expect(await runManualCypher('MATCH (n) RETURN n')).toEqual({
      success: false,
      error: 'session store unreachable',
    })
    expect(ops.runManualCypher).not.toHaveBeenCalled()
  })

  it('consults the authenticated user on every call, and delegates when it resolves', async () => {
    await getSchema()
    expect(getAuthenticatedUser).toHaveBeenCalledTimes(1)
    expect(ops.getSchema).toHaveBeenCalledTimes(1)
    expect(ops.getSchema).toHaveBeenCalledWith()
  })

  it('delegates each RPC with its caller arguments, returning the op result verbatim', async () => {
    await getNodeProperties('4:abc:1')
    expect(ops.getNodeProperties).toHaveBeenCalledWith('4:abc:1')

    await runManualCypher('MATCH (n) RETURN n')
    expect(ops.runManualCypher).toHaveBeenCalledWith('MATCH (n) RETURN n')

    await expect(getSchemaForAgent()).resolves.toEqual({ success: true, schema: 'op:agent' })
  })

  it('honours the DEV-gated dev bypass without consulting the session', async () => {
    isBypassEnabled.mockReturnValue(true)
    getAuthenticatedUser.mockRejectedValue(new Error('Authentication required'))

    expect((await getSchema()).success).toBe(true)
    expect(getAuthenticatedUser).not.toHaveBeenCalled()
    expect(ops.getSchema).toHaveBeenCalledTimes(1)
  })
})

// Regression pin for #228: `executeWriteCypher(cypher)` was a `'use server'`
// export here — browser-reachable, unauthenticated, and it ran whatever string
// it was handed. It is gone; graph writes go through the intent-shaped,
// authenticated ops behind `graph-edit.server.ts` (pinned package-side).
// Re-adding any raw-Cypher write RPC to this module fails this.
describe('no arbitrary-Cypher write RPC (#228)', () => {
  it('is not exported from the module', async () => {
    expect(Object.keys(queries)).not.toContain('executeWriteCypher')
  })
})

// Class pins for #230, held on the source rather than on one symbol: adding an
// export that skips the auth gate, or one that opens a session of its own,
// fails here even if it never appears in a behavioural test. (The read-only
// SESSION pin lives package-side with the ops that open the sessions; this is
// its app-side complement — the wrappers open none at all, so nothing client-
// reachable can bypass the package's READ-mode discipline by going around it.)
describe('every RPC in this module is gated and opens no session (#230 / SD-14)', () => {
  it('gates every exported server function on denyUnauthenticated()', () => {
    const source = wrapperSource()
    const exported = source.match(/^export async function /gm) ?? []
    const gated = source.match(/^ {2}const denied = await denyUnauthenticated\(\)$/gm) ?? []

    expect(exported.length).toBeGreaterThan(0)
    expect(gated).toHaveLength(exported.length)
  })

  it('opens no sessions and imports no driver — the package ops own both', () => {
    const source = wrapperSource()
    expect(source).not.toMatch(/\.session\(/)
    expect(source).not.toMatch(/neo4j-driver/)
    expect(source).not.toMatch(/getNeo4jDriver/)
  })
})
