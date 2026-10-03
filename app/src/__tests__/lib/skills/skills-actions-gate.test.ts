/**
 * The Skills RPC surface (#415, SD-13): every export of the `'use server'`
 * module is browser-callable, so each is pinned twice.
 *
 * 1. A source scan — every exported function's FIRST statement is the gate,
 *    no export takes an owner argument, and the module exports no value a
 *    browser could call that is not a gated function.
 * 2. Behaviour — an unauthenticated caller is refused by every export before
 *    any repository call, and each export acts as the SESSION's user.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SOURCE = readFileSync(resolve(process.cwd(), 'src/lib/skills/actions.server.ts'), 'utf8')

// ============================================================================
// 1. Source scan
// ============================================================================

/** `export async function name(params)…{` — every exported function. */
const EXPORTS = [...SOURCE.matchAll(/^export async function (\w+)\(([^)]*)\)[^{]*\{\n(.*)$/gm)]

describe('skills actions — source scan', () => {
  it('is a use-server module', () => {
    expect(SOURCE).toMatch(/^'use server'$/m)
  })

  it('finds the six RPCs', () => {
    expect(EXPORTS.map((m) => m[1]).sort()).toEqual([
      'deleteSkill',
      'getSkillContent',
      'listSkills',
      'setSkillGlobal',
      'setSkillHidden',
      'uploadSkill',
    ])
  })

  it('gates every export on its FIRST statement', () => {
    for (const [, name, , firstLine] of EXPORTS) {
      expect(firstLine.trim(), `${name} must open with the gate`).toBe(
        'const user = await requireUser()',
      )
    }
  })

  it('takes no owner argument anywhere — the owner is the session', () => {
    for (const [, name, params] of EXPORTS) {
      expect(params, `${name} names an owner in its parameters`).not.toMatch(
        /\b(user|userId|owner|ownerId|author|authorId|tenant)\b/i,
      )
    }
  })

  it('exports nothing callable but those functions', () => {
    const exported = [...SOURCE.matchAll(/^export\s+(\w+(?:\s+\w+)?)/gm)].map((m) => m[1])
    for (const kind of exported) {
      expect([
        'async function',
        'interface SkillView',
        'type SkillActionResult',
        'type UploadSkillResult',
      ]).toContain(kind)
    }
  })

  it('keeps the gate itself private and identity-free in what it returns', () => {
    expect(SOURCE).toMatch(/^async function requireUser\(\): Promise<\{ id: string \}> \{$/m)
    expect(SOURCE).not.toMatch(/^export .*requireUser/m)
  })
})

// ============================================================================
// 2. Behaviour
// ============================================================================

const auth = vi.hoisted(() => ({
  getAuthenticatedUser: vi.fn(),
  bypass: false,
}))
vi.mock('../../../lib/auth/server', () => ({
  getAuthenticatedUser: auth.getAuthenticatedUser,
}))
vi.mock('../../../lib/auth/dev-bypass', () => ({
  BYPASS_USER: { id: 'dev-bypass-user', email: 'dev@local' },
  isBypassEnabled: () => auth.bypass,
}))
const users = vi.hoisted(() => ({ getUser: vi.fn() }))
vi.mock('../../../lib/auth/users.server', () => users)

const repo = vi.hoisted(() => {
  class SkillRejectedError extends Error {}
  return {
    SkillRejectedError,
    createSkill: vi.fn(),
    deleteSkill: vi.fn(),
    getSkillContents: vi.fn(),
    listSkillsVisibleTo: vi.fn(),
    setSkillGlobal: vi.fn(),
    setSkillHidden: vi.fn(),
  }
})
vi.mock('../../../lib/db/skills.server', () => repo)

const actions = await import('../../../lib/skills/actions.server')

const ID = 'skill-00000000-0000-0000-0000-000000000001'
const record = (over: Record<string, unknown> = {}) => ({
  id: ID,
  userId: 'me',
  name: 'pdf',
  description: 'd',
  isGlobal: false,
  hidden: false,
  createdAt: new Date(1000),
  updatedAt: new Date(1000),
  ...over,
})
const VALID = '---\nname: pdf\ndescription: Use for PDFs.\n---\nbody\n'

const repoCalls = () =>
  Object.values(repo).reduce(
    (n, fn) => n + ((fn as { mock?: { calls: unknown[] } }).mock?.calls.length ?? 0),
    0,
  )

beforeEach(() => {
  vi.clearAllMocks()
  auth.bypass = false
  auth.getAuthenticatedUser.mockResolvedValue({ id: 'me', email: 'me@x' })
  repo.listSkillsVisibleTo.mockResolvedValue([])
  repo.getSkillContents.mockResolvedValue(new Map())
  repo.setSkillGlobal.mockResolvedValue(true)
  repo.setSkillHidden.mockResolvedValue(true)
  repo.deleteSkill.mockResolvedValue(true)
})

describe('skills actions — the gate, by behaviour', () => {
  const calls: Array<[string, () => Promise<unknown>]> = [
    ['listSkills', () => actions.listSkills()],
    ['uploadSkill', () => actions.uploadSkill(VALID)],
    ['setSkillGlobal', () => actions.setSkillGlobal(ID, true)],
    ['setSkillHidden', () => actions.setSkillHidden(ID, true)],
    ['deleteSkill', () => actions.deleteSkill(ID)],
    ['getSkillContent', () => actions.getSkillContent(ID)],
  ]

  it.each(calls)(
    '%s refuses an unauthenticated caller before touching the repository',
    async (_, call) => {
      auth.getAuthenticatedUser.mockRejectedValue(new Error('Authentication required'))
      await expect(call()).rejects.toThrow('Authentication required')
      expect(repoCalls()).toBe(0)
    },
  )

  it('acts as the session’s user — and as the bypass user only when bypass is on', async () => {
    await actions.deleteSkill(ID)
    expect(repo.deleteSkill).toHaveBeenCalledWith(ID, 'me')
    auth.bypass = true
    await actions.deleteSkill(ID)
    expect(repo.deleteSkill).toHaveBeenLastCalledWith(ID, 'dev-bypass-user')
    expect(auth.getAuthenticatedUser).toHaveBeenCalledTimes(1)
  })
})

describe('skills actions — arguments are untrusted', () => {
  it.each([
    ['a non-id string', 'not-a-skill-id'],
    ['a number', 7],
    ['an object', { id: ID }],
  ])('treats %s as not found, without a repository call', async (_, bad) => {
    expect(await actions.deleteSkill(bad)).toEqual({
      ok: false,
      error: 'That skill was not found.',
    })
    expect(await actions.setSkillGlobal(bad, true)).toMatchObject({ ok: false })
    expect(await actions.setSkillHidden(bad, true)).toMatchObject({ ok: false })
    expect(await actions.getSkillContent(bad)).toBeNull()
    expect(repoCalls()).toBe(0)
  })

  it('refuses a non-boolean flag', async () => {
    expect(await actions.setSkillGlobal(ID, 'true')).toMatchObject({ ok: false })
    expect(await actions.setSkillHidden(ID, 1)).toMatchObject({ ok: false })
    expect(repoCalls()).toBe(0)
  })

  it('passes a refusal from the repository through as not found', async () => {
    repo.setSkillGlobal.mockResolvedValue(false)
    expect(await actions.setSkillGlobal(ID, true)).toEqual({
      ok: false,
      error: 'That skill was not found.',
    })
  })
})

describe('skills actions — upload', () => {
  it('checks the size before parsing, and before any repository call', async () => {
    const r = await actions.uploadSkill('x'.repeat(64 * 1024 + 1))
    expect(r).toEqual({ ok: false, error: 'SKILL.md is larger than 65536 bytes (64 KiB).' })
    expect(repoCalls()).toBe(0)
  })

  it('refuses a non-string and an invalid file with the validator’s message', async () => {
    expect(await actions.uploadSkill(42)).toEqual({
      ok: false,
      error: 'Upload a SKILL.md text file.',
    })
    expect(await actions.uploadSkill('no frontmatter')).toMatchObject({ ok: false })
    expect(repo.createSkill).not.toHaveBeenCalled()
  })

  it('stores a valid file as the caller’s private skill', async () => {
    repo.createSkill.mockImplementation(async (input: { id: string }) => record({ id: input.id }))
    repo.listSkillsVisibleTo.mockImplementation(async () => [record()])
    const r = await actions.uploadSkill(VALID)
    expect(repo.createSkill).toHaveBeenCalledWith({
      id: expect.stringMatching(/^skill-[0-9a-f-]{36}$/),
      userId: 'me',
      name: 'pdf',
      description: 'Use for PDFs.',
      content: VALID,
    })
    expect(r).toMatchObject({ ok: true, skill: { name: 'pdf', mine: true, isGlobal: false } })
  })

  it('turns a repository rule into a message, and lets anything else throw', async () => {
    repo.createSkill.mockRejectedValueOnce(
      new repo.SkillRejectedError('You already have a skill named "pdf".'),
    )
    expect(await actions.uploadSkill(VALID)).toEqual({
      ok: false,
      error: 'You already have a skill named "pdf".',
    })
    repo.createSkill.mockRejectedValueOnce(new Error('db down'))
    await expect(actions.uploadSkill(VALID)).rejects.toThrow('db down')
  })
})

describe('skills actions — list', () => {
  it('names the author of another user’s global skill, never of the caller’s own', async () => {
    repo.listSkillsVisibleTo.mockResolvedValue([
      record(),
      record({ id: 'skill-2', userId: 'ada', name: 'style', isGlobal: true }),
      record({ id: 'skill-3', userId: 'ghost', name: 'old', isGlobal: true, hidden: true }),
      record({ id: 'skill-4', userId: 'dev-bypass-user', name: 'dev', isGlobal: true }),
    ])
    users.getUser.mockImplementation(async (id: string) =>
      id === 'ada' ? { id, email: 'ada@x', displayName: 'Ada Lovelace' } : null,
    )
    const list = await actions.listSkills()
    expect(repo.listSkillsVisibleTo).toHaveBeenCalledWith('me')
    expect(list.map((s) => [s.name, s.mine, s.author, s.status])).toEqual([
      ['pdf', true, null, 'mounted'],
      ['style', false, 'Ada Lovelace', 'mounted'],
      ['old', false, 'Unknown author', 'hidden'],
      ['dev', false, 'dev@local', 'mounted'],
    ])
    expect(users.getUser).not.toHaveBeenCalledWith('me')
  })

  it('reads a file as the caller', async () => {
    repo.getSkillContents.mockResolvedValue(new Map([[ID, 'FILE']]))
    expect(await actions.getSkillContent(ID)).toBe('FILE')
    expect(repo.getSkillContents).toHaveBeenCalledWith('me', [ID])
  })
})
