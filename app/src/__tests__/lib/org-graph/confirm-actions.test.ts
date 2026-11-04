// @vitest-environment node
/**
 * `lib/org-graph/confirm-actions.server.ts` — the org-knowledge confirmation
 * RPCs (slice 4). Security properties (SD-13): every export gates on the
 * authenticated user BEFORE any resource is opened, takes no owner, and a
 * client supplies a choice id with flags and nothing else.
 *
 * Pin "the action refuses an unauthenticated caller" — mutation: skip the gate
 * → the answer reaches `answerOrgProposalFor`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const getAuthenticatedUser = vi.fn<() => Promise<{ id: string; email: string }>>()
vi.mock('../../../lib/auth/server', () => ({ getAuthenticatedUser: () => getAuthenticatedUser() }))
let bypass = false
vi.mock('../../../lib/auth/dev-bypass', () => ({
  isBypassEnabled: () => bypass,
  BYPASS_USER: { id: 'dev-bypass-user', email: 'dev@local' },
}))
const answerFor = vi.fn(async (..._a: unknown[]) => ({ outcome: 'discarded' }))
const listFor = vi.fn(async (..._a: unknown[]) => [])
vi.mock('../../../lib/org-graph/proposals.server', () => ({
  answerOrgProposalFor: (...a: unknown[]) => answerFor(...a),
  listOrgProposalsFor: (...a: unknown[]) => listFor(...a),
}))

const { answerOrgProposal, listOrgProposals } =
  await import('../../../lib/org-graph/confirm-actions.server')

const source = () =>
  readFileSync(path.resolve(process.cwd(), 'src/lib/org-graph/confirm-actions.server.ts'), 'utf8')

beforeEach(() => {
  vi.clearAllMocks()
  bypass = false
  getAuthenticatedUser.mockResolvedValue({ id: 'alice', email: 'a@x.test' })
})

describe('SD-13: the gate', () => {
  it('is a use-server module whose every export gates first and takes no owner', () => {
    const src = source()
    expect(src).toMatch(/^'use server'$/m)
    const exports = [...src.matchAll(/export async function (\w+)\(([^)]*)\)[^{]*\{\n([^\n]*)/g)]
    expect(exports.map((m) => m[1]).sort()).toEqual(['answerOrgProposal', 'listOrgProposals'])
    for (const [, , params, firstLine] of exports) {
      expect(firstLine.trim()).toBe('const user = await requireUser()')
      expect(params).not.toMatch(/userId|owner/)
    }
  })

  it('refuses an unauthenticated caller before any proposal is read or answered', async () => {
    getAuthenticatedUser.mockRejectedValue(new Error('Authentication required'))
    await expect(answerOrgProposal('c-1', 'r-1', 'add')).rejects.toThrow(/Authentication required/)
    await expect(listOrgProposals('c-1')).rejects.toThrow(/Authentication required/)
    expect(answerFor).not.toHaveBeenCalled()
    expect(listFor).not.toHaveBeenCalled()
  })

  it('passes the SESSION user down, never a client-chosen one', async () => {
    await answerOrgProposal('c-1', 'r-1', { choice: 'add', flags: { a0: true } })
    expect(answerFor).toHaveBeenCalledWith('alice', 'c-1', 'r-1', {
      choice: 'add',
      flags: { a0: true },
    })
    bypass = true
    await listOrgProposals('c-1')
    expect(listFor).toHaveBeenCalledWith('dev-bypass-user', 'c-1')
  })

  it('refuses an answer that is not a choice id with boolean flags', async () => {
    for (const bad of [
      { choice: 'add', flags: { a0: 'yes' } },
      { choice: 1 },
      { choice: 'add', payload: {} },
    ]) {
      await expect(answerOrgProposal('c-1', 'r-1', bad as never)).rejects.toThrow(/not a choice id/)
    }
    expect(answerFor).not.toHaveBeenCalled()
  })
})
