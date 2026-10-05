/**
 * `lib/hitl/actions.server.ts` — the answer RPC (#433 S7).
 *
 * Two things are pinned here, and both are security properties rather than
 * feature tests:
 *
 * - **SD-13.** Every export of the `'use server'` module gates on the
 *   authenticated user before any resource is opened, and no export takes an
 *   owner parameter. Pinned on the source (the class-pins shape the Neo4j
 *   wrapper uses) and at runtime: an unauthenticated caller is refused before
 *   the conversation is ever loaded.
 * - **A2/A6.** What a client may supply is choice ids and flags, and NOTHING
 *   else; and the answer RPC never writes the conversation blob — the
 *   decision state is the blob's `hitl_*` events, and only the resume turn
 *   (`turn.server.ts`, core `resumeHarness`) writes those.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}))

// The reader is REAL: the RPC derives pending requests exactly as the resume
// does, from the same core code. `deserializeContext` comes with it.
vi.mock('@hames-ai/harness-patterns', async () => {
  const real = await vi.importActual<typeof import('@hames-ai/harness-patterns')>(
    '@hames-ai/harness-patterns',
  )
  return { ...real }
})

const getAuthenticatedUser = vi.fn<() => Promise<{ id: string; email: string }>>()
vi.mock('../../../lib/auth/server', () => ({ getAuthenticatedUser: () => getAuthenticatedUser() }))
let bypass = false
vi.mock('../../../lib/auth/dev-bypass', () => ({
  isBypassEnabled: () => bypass,
  BYPASS_USER: { id: 'dev-bypass-user', email: 'dev@local' },
}))

/** The write the RPC owns, mocked so the tests see the recorded answers. */
const recordHitlAnswer = vi.fn(async () => true)
vi.mock('../../../lib/db/hitl.server', async () => {
  const real = await vi.importActual<typeof import('../../../lib/db/hitl.server')>(
    '../../../lib/db/hitl.server',
  )
  return { ...real, recordHitlAnswer: (...a: unknown[]) => recordHitlAnswer(...(a as [])) }
})

const loadSession = vi.fn<(s: string, u: string) => Promise<Record<string, unknown> | null>>(
  async () => null,
)
const saveSession = vi.fn((..._a: unknown[]) => undefined)
vi.mock('../../../lib/harness-client/session.server', () => ({
  loadSession: (s: string, u: string) => loadSession(s, u),
  saveSession: (s: string, u: string, a: string, c: string, h: unknown) =>
    saveSession(s, u, a, c, h),
  claimSession: vi.fn(),
  getOrBuildPatterns: vi.fn(),
  agentDeps: () => ({}),
}))

const { answerHitl } = await import('../../../lib/hitl/actions.server')

const actionsSource = () =>
  readFileSync(path.resolve(process.cwd(), 'src/lib/hitl/actions.server.ts'), 'utf8')

/** A paused context with one pending `confirm` request, hand-built the way a
 *  paused run's serialized blob looks. Real `readHitl` derives from it. */
function pausedBlob(): string {
  return JSON.stringify({
    sessionId: 's1',
    status: 'paused',
    input: 'do it',
    data: {},
    events: [
      { id: 'ev1', type: 'user_message', ts: 1, patternId: 'harness', data: { content: 'do it' } },
      {
        id: 'ev2',
        type: 'hitl_request',
        ts: 2,
        patternId: 'harness',
        data: {
          v: 1,
          requestId: 'req-1',
          runId: 'run-1',
          key: 'confirm:abc',
          kind: 'confirm',
          question: 'Proceed?',
          options: [
            { id: 'approve', label: 'Approve' },
            { id: 'reject', label: 'Reject', stopsRun: true },
            { id: 'later', label: 'Later', unavailable: 'not now' },
            {
              id: 'verified',
              label: 'Continue',
              flags: [
                { id: 'confirmVerified', label: 'I verified', default: false, required: true },
              ],
            },
          ],
          defaultOption: 'approve',
          unattended: 'park',
          summary: {},
          blocking: true,
          resumeAt: { index: 0, names: ['p1'] },
          tier: 'anthropic',
        },
      },
    ],
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  bypass = false
  getAuthenticatedUser.mockRejectedValue(new Error('unauthenticated'))
  loadSession.mockResolvedValue(null)
  recordHitlAnswer.mockResolvedValue(true)
})

describe('the SD-13 gate', () => {
  it('gates every exported server function on the authenticated user, first', () => {
    const source = actionsSource()
    const exported = source.match(/^export async function /gm) ?? []
    const gated = source.match(/^ {2}const user = await requireUser\(\)$/gm) ?? []
    expect(exported.length).toBeGreaterThan(0)
    // A new export cannot be added without deciding how it is gated: the gate
    // must appear once per export, as its first statement.
    expect(gated.length).toBe(exported.length)
    // The shared helper itself is module-private, so it is not an RPC.
    expect(source).toMatch(/^async function requireUser\(\)/m)
  })

  it('takes no owner parameter — the owner is never an argument', () => {
    const ownerArgs =
      actionsSource().match(
        /^export (?:async )?function \w+\([^)]*(?:userId|user_id|ownerId|owner)/gm,
      ) ?? []
    expect(ownerArgs).toEqual([])
  })

  it('refuses an unauthenticated caller before any resource is opened', async () => {
    await expect(answerHitl('s1', {})).rejects.toThrow('unauthenticated')
    expect(loadSession).not.toHaveBeenCalled()
    expect(recordHitlAnswer).not.toHaveBeenCalled()
  })

  it('runs as the DEV-only bypass user when the bypass is enabled', async () => {
    bypass = true
    loadSession.mockResolvedValue(null)
    await expect(answerHitl('s1', {})).rejects.toThrow('Conversation not found')
    expect(loadSession).toHaveBeenCalledWith('s1', 'dev-bypass-user')
  })
})

describe('what a client may supply (A2)', () => {
  beforeEach(() => {
    getAuthenticatedUser.mockResolvedValue({ id: 'user-a', email: 'a@x.example' })
  })

  it('refuses anything but choice ids and flags — before the conversation loads', async () => {
    // F4: `resolution` and `principal` left the answer type in S3 — a client
    // smuggling either back in a value must be refused at the boundary, not
    // recorded (a `resolution` would be text substituted into the model's
    // `tool_result`; a `principal` would be the recorded decider).
    await expect(
      answerHitl('s1', {
        'req-1': { choice: 'approve', resolution: 'The user chose: it.' } as never,
      }),
    ).rejects.toThrow('not a choice id')
    await expect(
      answerHitl('s1', { 'req-1': { choice: 'approve', principal: 'someone-else' } as never }),
    ).rejects.toThrow('not a choice id')
    expect(loadSession).not.toHaveBeenCalled()
    expect(recordHitlAnswer).not.toHaveBeenCalled()
  })

  it('refuses flags with non-boolean values, and non-object answers wholesale', async () => {
    await expect(
      answerHitl('s1', {
        'req-1': { choice: 'approve', flags: { verbose: 'yes' as unknown as boolean } },
      }),
    ).rejects.toThrow('not a choice id')
    await expect(answerHitl('s1', ['req-1'] as never)).rejects.toThrow()
  })
})

describe('answerHitl', () => {
  beforeEach(() => {
    getAuthenticatedUser.mockResolvedValue({ id: 'user-a', email: 'a@x.example' })
    loadSession.mockResolvedValue({
      serializedContext: pausedBlob(),
      agentId: 'search',
      kind: 'conversation',
      status: 'paused',
    })
  })

  it('records a valid answer against the stored request, and never writes the blob', async () => {
    const out = await answerHitl('s1', { 'req-1': 'approve' })
    expect(out).toEqual([{ requestId: 'req-1', outcome: 'answered' }])
    expect(recordHitlAnswer).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req-1',
        userId: 'user-a',
        sessionId: 's1',
        kind: 'confirm',
        blocksRun: true,
        answer: 'approve',
      }),
    )
    // A6: the answer RPC is transport. The blob's writers are not even in this
    // module's import set — and none was called.
    expect(saveSession).not.toHaveBeenCalled()
    expect(loadSession).toHaveBeenCalledTimes(1)
  })

  it('a second answer to the same request is already-answered (first wins)', async () => {
    recordHitlAnswer.mockResolvedValue(false)
    const out = await answerHitl('s1', { 'req-1': { choice: 'reject', flags: {} } })
    expect(out).toEqual([{ requestId: 'req-1', outcome: 'already-answered' }])
  })

  it('checks the answer against the stored request: every option failure is named', async () => {
    expect(await answerHitl('s1', { nope: 'approve' })).toEqual([
      { requestId: 'nope', outcome: 'unknown-request' },
    ])
    expect(await answerHitl('s1', { 'req-1': 'other' })).toEqual([
      { requestId: 'req-1', outcome: 'invalid-choice' },
    ])
    expect(await answerHitl('s1', { 'req-1': 'later' })).toEqual([
      { requestId: 'req-1', outcome: 'unavailable-option' },
    ])
    expect(
      await answerHitl('s1', { 'req-1': { choice: 'approve', flags: { nope: true } } }),
    ).toEqual([{ requestId: 'req-1', outcome: 'invalid-flag' }])
    expect(await answerHitl('s1', { 'req-1': { choice: 'verified', flags: {} } })).toEqual([
      { requestId: 'req-1', outcome: 'required-flag' },
    ])
    expect(recordHitlAnswer).not.toHaveBeenCalled()
  })

  it('refuses a past-due request as expired rather than recording an answer nothing consumes', async () => {
    const due = JSON.parse(pausedBlob())
    due.events[1].data.expiresAt = Date.now() - 1_000
    loadSession.mockResolvedValue({
      serializedContext: JSON.stringify(due),
      agentId: 'search',
      kind: 'conversation',
      status: 'paused',
    })
    expect(await answerHitl('s1', { 'req-1': 'approve' })).toEqual([
      { requestId: 'req-1', outcome: 'expired' },
    ])
    expect(recordHitlAnswer).not.toHaveBeenCalled()
  })

  it('sees nothing pending on a run that is not paused', async () => {
    const done = JSON.parse(pausedBlob())
    done.status = 'done'
    loadSession.mockResolvedValue({
      serializedContext: JSON.stringify(done),
      agentId: 'search',
      kind: 'conversation',
      status: 'done',
    })
    expect(await answerHitl('s1', { 'req-1': 'approve' })).toEqual([
      { requestId: 'req-1', outcome: 'unknown-request' },
    ])
  })

  it('answers only for its owner: a foreign conversation is not found', async () => {
    loadSession.mockResolvedValue(null)
    await expect(answerHitl('someone-elses', { 'req-1': 'approve' })).rejects.toThrow(
      'Conversation not found',
    )
  })
})
