/**
 * Triggered-action runner (`lib/harness-client/action-runner.server.ts`) —
 * the fire-and-forget path shared by `POST /api/agents/:id` and routines.
 *
 * Asserts the two contracts the route depends on: the seeded row is a valid,
 * replayable `action` row that exists before the run, and the background run
 * itself is the shared turn driver in `triggered` mode (`turn.server.ts`,
 * pinned by `turn.test.ts`) with its rejection stopping here — nobody is
 * awaiting it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

const runTurnAndPersist = vi.fn<(req: Record<string, unknown>) => Promise<unknown>>(
  async () => ({}),
)
vi.mock('../../../lib/harness-client/turn.server', () => ({ runTurnAndPersist }))

type Saved = Record<string, unknown>
const dbCreateConversation = vi.fn<(row: Saved) => Promise<string>>(async () => 'v-seed')
const dbReleaseConversationClaim = vi.fn<
  (id: string, userId: string, version: string, opts?: { failed?: boolean }) => Promise<boolean>
>(async () => true)
vi.mock('../../../lib/db/conversations.server', () => ({
  createConversation: dbCreateConversation,
  releaseConversationClaim: dbReleaseConversationClaim,
}))

const { seedActionRow, runAgentInBackground } =
  await import('../../../lib/harness-client/action-runner.server')
const { deserializeContext } = await import('@hames-ai/harness-patterns')

const TRIGGER = {
  transcribedCommand: 'Summarise yesterday’s incident',
  shortDescription: 'Incident summary',
  recordingDocId: 'doc-9',
  recordingFilename: 'note.m4a',
  recordingMimeType: 'audio/mp4',
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('seedActionRow', () => {
  it('inserts a running action row whose context replays the trigger command', async () => {
    // The row is created claimed for its run (#458), and the claim is what
    // the caller hands the run.
    await expect(seedActionRow('run-1', 'user-1', 'search', TRIGGER)).resolves.toBe('v-seed')

    const row = dbCreateConversation.mock.calls[0][0]
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
    expect(dbCreateConversation.mock.calls[0][0]).toMatchObject({
      kind: 'action',
      source: 'routine',
    })
  })

  it('stores a null title when the trigger carries no description', async () => {
    await seedActionRow('run-3', 'user-1', 'search', { ...TRIGGER, shortDescription: '' })
    expect(dbCreateConversation.mock.calls[0][0]).toMatchObject({ title: null })
  })
})

describe('runAgentInBackground', () => {
  it('drives one triggered turn, carrying the trigger as the run’s data', async () => {
    await runAgentInBackground('run-4', 'user-1', 'do the thing', 'search', TRIGGER, 'v-seed')

    expect(runTurnAndPersist).toHaveBeenCalledWith({
      mode: 'triggered',
      sessionId: 'run-4',
      userId: 'user-1',
      agentId: 'search',
      message: 'do the thing',
      data: { trigger: TRIGGER },
      // The seed's claim: the run takes the row the seed created for it.
      claimVersion: 'v-seed',
    })
    expect(dbReleaseConversationClaim).not.toHaveBeenCalled()
  })

  // The driver has already logged the failure and flipped the row off
  // 'running' (sf-M2/sf-M3). Rethrowing here would only surface as an
  // unhandled rejection: the callers `void` this.
  it('never rejects — a failed run must not take the process with it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    runTurnAndPersist.mockRejectedValueOnce(new Error('gateway down'))

    await expect(
      runAgentInBackground('run-5', 'user-1', 'x', 'search', TRIGGER, 'v-seed'),
    ).resolves.toBeUndefined()
  })

  // A throw from before the turn's own catch (a tier this deployment refuses)
  // used to leave the seeded row spinning — and would now leave it claimed for
  // a lease. The release is fenced by the seed's claim, so after a turn that
  // already released it this is a no-op in the database.
  // MUTATION: drop the release from the `.catch` → the assertion reddens.
  it('lets go of the seed’s claim, marking the run failed, whatever threw', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    runTurnAndPersist.mockRejectedValueOnce(new Error('verda tier is not configured'))

    await runAgentInBackground('run-6', 'user-1', 'x', 'search', TRIGGER, 'v-seed')

    expect(dbReleaseConversationClaim).toHaveBeenCalledWith('run-6', 'user-1', 'v-seed', {
      failed: true,
    })
    expect(logged).toHaveBeenCalledWith('[action] run run-6 failed:', expect.any(Error))
  })

  it('still never rejects when the release itself fails', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    runTurnAndPersist.mockRejectedValueOnce(new Error('gateway down'))
    dbReleaseConversationClaim.mockRejectedValueOnce(new Error('postgres down'))

    await expect(
      runAgentInBackground('run-7', 'user-1', 'x', 'search', TRIGGER, 'v-seed'),
    ).resolves.toBeUndefined()
    expect(logged).toHaveBeenCalledWith(
      "[action] could not flip run run-7 to status='error':",
      expect.any(Error),
    )
  })
})
