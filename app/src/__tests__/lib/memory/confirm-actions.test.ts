/**
 * `lib/memory/confirm-actions.server.ts` — the memory confirmation RPCs (M6).
 *
 * Security properties, not features (SD-13): every export of the `'use server'`
 * module gates on the authenticated user BEFORE any resource is opened, takes
 * no owner parameter, and a client supplies choice ids and flags and nothing
 * else. Pinned on the source and at runtime.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}))

const getAuthenticatedUser = vi.fn<() => Promise<{ id: string; email: string }>>()
vi.mock('../../../lib/auth/server', () => ({ getAuthenticatedUser: () => getAuthenticatedUser() }))
let bypass = false
vi.mock('../../../lib/auth/dev-bypass', () => ({
  isBypassEnabled: () => bypass,
  BYPASS_USER: { id: 'dev-bypass-user', email: 'dev@local' },
}))

const answerFor = vi.fn(async (..._a: unknown[]) => ({ outcome: 'discarded' }))
const listFor = vi.fn(async (..._a: unknown[]) => [])
vi.mock('../../../lib/memory/proposals.server', () => ({
  answerMemoryProposalFor: (...a: unknown[]) => answerFor(...a),
  listMemoryProposalsFor: (...a: unknown[]) => listFor(...a),
}))

const { listMemoryProposals, answerMemoryProposal } =
  await import('../../../lib/memory/confirm-actions.server')

const source = () =>
  readFileSync(path.resolve(process.cwd(), 'src/lib/memory/confirm-actions.server.ts'), 'utf8')

beforeEach(() => {
  vi.clearAllMocks()
  bypass = false
  getAuthenticatedUser.mockResolvedValue({ id: 'alice', email: 'a@x.test' })
})

describe('SD-13: the gate', () => {
  // MUTATION: add an export without the gate (or take a userId parameter) → red.
  it('every exported function is gated first and takes no owner', () => {
    const src = source()
    expect(src.trimStart().startsWith('/**')).toBe(true)
    expect(src).toMatch(/^'use server'$/m)
    const fns = [...src.matchAll(/^export async function (\w+)\(([\s\S]*?)\): Promise/gm)]
    expect(fns.map((m) => m[1]).sort()).toEqual(['answerMemoryProposal', 'listMemoryProposals'])
    // nothing else is a value export: a helper here would itself be an RPC
    expect([...src.matchAll(/^export (?!type |async function )/gm)]).toEqual([])
    for (const [, name, params] of fns) {
      expect(params, `${name} must not take an owner`).not.toMatch(/user(Id)?\b|owner/i)
      // the gate is the FIRST STATEMENT: not merely the first await, so no
      // validation, load or lookup can run before the caller is known
      const from = src.indexOf(`export async function ${name}`)
      const body = src.slice(from, src.indexOf('\nexport ', from + 1) + 1 || undefined)
      expect(body, `${name} gates first`).toMatch(/\{\n {2}const user = await requireUser\(\)\n/)
    }
  })

  // MUTATION: move the gate after the shape check / the load → red.
  it('an unauthenticated caller is refused before anything is opened', async () => {
    getAuthenticatedUser.mockRejectedValue(new Error('no session'))
    await expect(listMemoryProposals('s1')).rejects.toThrow('no session')
    await expect(answerMemoryProposal('s1', 'r1', 'discard')).rejects.toThrow('no session')
    expect(listFor).not.toHaveBeenCalled()
    expect(answerFor).not.toHaveBeenCalled()
  })

  it('passes the SESSION user, never a caller-chosen one', async () => {
    await listMemoryProposals('s1')
    await answerMemoryProposal('s1', 'r1', { choice: 'save', flags: { i0: true } })
    expect(listFor).toHaveBeenCalledWith('alice', 's1')
    expect(answerFor).toHaveBeenCalledWith('alice', 's1', 'r1', {
      choice: 'save',
      flags: { i0: true },
    })
  })

  it('the dev bypass identity is the one shared bypass user', async () => {
    bypass = true
    await listMemoryProposals('s1')
    expect(listFor).toHaveBeenCalledWith('dev-bypass-user', 's1')
    expect(getAuthenticatedUser).not.toHaveBeenCalled()
  })
})

describe('what a client may supply', () => {
  // MUTATION: drop `isAnswerShape` → a smuggled principal/resolution/payload gets through → red.
  it.each([
    [{ choice: 'save', principal: 'mallory' }],
    [{ choice: 'save', resolution: 'x' }],
    [{ choice: 'save', payload: { items: [] } }],
    [{ choice: 'save', flags: { i0: 'yes' } }],
    [{ flags: { i0: true } }],
    [null],
    [7],
    [['save']],
  ])('refuses %j before the conversation is loaded', async (bad) => {
    await expect(answerMemoryProposal('s1', 'r1', bad as never)).rejects.toThrow(
      'an answer is not a choice id',
    )
    expect(answerFor).not.toHaveBeenCalled()
  })

  it.each([
    ['', 'r1'],
    ['s1', ''],
    [undefined, 'r1'],
    ['s1', 7],
  ])('refuses ids %j / %j', async (s, r) => {
    await expect(answerMemoryProposal(s as never, r as never, 'discard')).rejects.toThrow(
      /is required/,
    )
    expect(answerFor).not.toHaveBeenCalled()
  })

  it('a list without a session id is refused', async () => {
    await expect(listMemoryProposals('')).rejects.toThrow('sessionId is required')
    expect(listFor).not.toHaveBeenCalled()
  })
})
