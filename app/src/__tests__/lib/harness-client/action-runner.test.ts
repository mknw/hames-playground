/**
 * Triggered-action runner (`lib/harness-client/action-runner.server.ts`) —
 * the fire-and-forget path shared by `POST /api/agents/:id` and routines.
 *
 * Asserts the two contracts the route depends on: the seeded row is a valid,
 * replayable `action` row that exists before the run, and a background failure
 * always leaves the row in a terminal state instead of spinning on 'running'.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

import {
  getRequestUserId,
  getRequestSessionId,
} from '../../../lib/harness-client/request-user.server'

const seenScopes: Array<{ userId: string | null; sessionId: string | null }> = []
const runAgent = vi.fn(async (message: string, sessionId: string, data: unknown) => {
  seenScopes.push({ userId: getRequestUserId(), sessionId: getRequestSessionId() })
  return { response: `ran:${message}`, serialized: JSON.stringify({ sessionId, data }), data: {} }
})
const harness = vi.fn(() => runAgent)
vi.mock('../../../lib/harness-patterns', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../../lib/harness-patterns')
  return { ...actual, harness }
})

const getOrBuildPatterns = vi.fn(async (_s: string, agentId: string) => [`patterns:${agentId}`])
const saveSession = vi.fn(async () => {})
vi.mock('../../../lib/harness-client/session.server', () => ({ getOrBuildPatterns, saveSession }))

type Saved = Record<string, unknown>
const dbSaveConversation = vi.fn<(row: Saved) => Promise<void>>(async () => {})
const dbSetConversationStatus = vi.fn<
  (id: string, userId: string, status: string) => Promise<void>
>(async () => {})
vi.mock('../../../lib/db/conversations.server', () => ({
  saveConversation: dbSaveConversation,
  setConversationStatus: dbSetConversationStatus,
}))

const { seedActionRow, runAgentInBackground } =
  await import('../../../lib/harness-client/action-runner.server')
const { deserializeContext } = await import('../../../lib/harness-patterns')

const TRIGGER = {
  transcribedCommand: 'Summarise yesterday’s incident',
  shortDescription: 'Incident summary',
  recordingDocId: 'doc-9',
  recordingFilename: 'note.m4a',
  recordingMimeType: 'audio/mp4',
}

beforeEach(() => {
  vi.clearAllMocks()
  seenScopes.length = 0
})

describe('seedActionRow', () => {
  it('inserts a running action row whose context replays the trigger command', async () => {
    await seedActionRow('run-1', 'user-1', 'search', TRIGGER)

    const row = dbSaveConversation.mock.calls[0][0]
    expect(row).toMatchObject({
      id: 'run-1',
      userId: 'user-1',
      agentId: 'search',
      title: 'Incident summary',
      kind: 'action',
      source: 'post', // default provenance for the POST endpoint
      status: 'running',
    })

    const ctx = deserializeContext(row.serializedContext as string)
    expect(ctx.sessionId).toBe('run-1')
    expect(ctx.events.map((e) => [e.type, (e.data as { content?: string }).content])).toEqual([
      ['user_message', 'Summarise yesterday’s incident'],
    ])
    // Provenance travels with the run so the UI can play the recording back.
    expect((ctx.data as { trigger?: unknown }).trigger).toEqual(TRIGGER)
  })

  it('records a routine-fired run with source=routine, otherwise identically', async () => {
    await seedActionRow('run-2', 'user-1', 'search', TRIGGER, 'routine')
    expect(dbSaveConversation.mock.calls[0][0]).toMatchObject({ kind: 'action', source: 'routine' })
  })

  it('stores a null title when the trigger carries no description', async () => {
    await seedActionRow('run-3', 'user-1', 'search', { ...TRIGGER, shortDescription: '' })
    expect(dbSaveConversation.mock.calls[0][0]).toMatchObject({ title: null })
  })
})

describe('runAgentInBackground', () => {
  it('runs a fresh turn under the run’s own user/session scope and persists the result', async () => {
    await runAgentInBackground('run-4', 'user-1', 'do the thing', 'search', TRIGGER)

    expect(getOrBuildPatterns).toHaveBeenCalledWith('run-4', 'search')
    expect(harness).toHaveBeenCalledWith('patterns:search')
    // Never continues the seeded placeholder — that would duplicate the user_message.
    expect(runAgent).toHaveBeenCalledWith('do the thing', 'run-4', { trigger: TRIGGER })
    expect(seenScopes).toEqual([{ userId: 'user-1', sessionId: 'run-4' }])
    expect(saveSession).toHaveBeenCalledWith(
      'run-4',
      'user-1',
      'search',
      JSON.stringify({ sessionId: 'run-4', data: { trigger: TRIGGER } }),
    )
  })

  it('flips the row to error when pattern construction throws, instead of spinning forever', async () => {
    getOrBuildPatterns.mockRejectedValueOnce(new Error('gateway down'))
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(
      runAgentInBackground('run-5', 'user-1', 'x', 'search', TRIGGER),
    ).resolves.toBeUndefined()

    expect(saveSession).not.toHaveBeenCalled()
    expect(dbSetConversationStatus).toHaveBeenCalledWith('run-5', 'user-1', 'error')
    expect(logged).toHaveBeenCalled()
    logged.mockRestore()
  })

  // sf-M3. The flip itself was `.catch(() => {})` with a comment claiming the
  // failure was "already logged above" — that log was about the RUN. When the
  // flip is what failed, the row keeps spinning and nothing said why.
  it('does not swallow a failure of the error-flip itself — it names the stuck row', async () => {
    getOrBuildPatterns.mockRejectedValueOnce(new Error('gateway down'))
    dbSetConversationStatus.mockRejectedValueOnce(new Error('db down'))
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    // Still swallowed as far as the caller is concerned — this is a
    // fire-and-forget background run and must not reject.
    await expect(
      runAgentInBackground('run-6', 'user-1', 'x', 'search', TRIGGER),
    ).resolves.toBeUndefined()

    expect(logged).toHaveBeenCalledWith(expect.stringContaining('run-6'), expect.anything())
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining('keep showing as'),
      expect.anything(),
    )
    logged.mockRestore()
  })
})
