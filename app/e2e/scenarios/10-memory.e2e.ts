/** #419 M10 / G9: synthetic memory conversations under the #516 backstop. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { ConfiguredPattern } from '@hames-ai/harness-patterns'
import type { SessionData } from '../../src/lib/harness-client/session.server'
import { bootApp, eventsOfType, newSessionId, settleSummaries, type AppHandles } from '../lib/app'
import { IS_HERMETIC, TIERS, SMALL_MODEL, FAKE_ANTHROPIC_TIER_MODEL } from '../lib/mode'
import { takeEgressAttempts } from '../lib/egress-backstop'

type MemoryData = SessionData &
  import('@hames-ai/harness-patterns/patterns/memoryRecall.server').MemoryRecallData
const MESSAGE = 'I prefer concise replies about synthetic gardens.'
const AGENT = 'e2e-memory'
let app: AppHandles
let sessions: typeof import('../../src/lib/harness-client/session.server')
let memories: typeof import('../../src/lib/db/memories.server')
let conversations: typeof import('../../src/lib/db/conversations.server')
let db: typeof import('../../src/lib/db/client.server')
let answer: () => ConfiguredPattern<SessionData>
let gate: (() => Promise<void>) | undefined

async function enabled(value: boolean) {
  await db.query('UPDATE user_prefs SET memory_enabled = $2 WHERE user_id = $1', [
    app.userId,
    value,
  ])
}
async function waitFor<T>(read: () => Promise<T>, accepts: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 15_000
  for (;;) {
    const value = await read()
    if (accepts(value)) return value
    if (Date.now() > deadline)
      throw new Error('memory continuation did not reach its expected boundary')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
async function settled(id: string) {
  return waitFor(
    () => app.readRow(id),
    (row) => !!row && eventsOfType(row.serializedContext, 'memory_written').length > 0,
  )
}
async function stored() {
  return memories.listMemoriesForUser(app.userId)
}
async function triggered(id: string, agentId = AGENT) {
  const runner = await import('../../src/lib/harness-client/action-runner.server')
  const trigger = { transcribedCommand: MESSAGE, shortDescription: 'Synthetic memory turn' }
  const version = await runner.seedActionRow(id, app.userId, agentId, trigger)
  await runner.runAgentInBackground(id, app.userId, MESSAGE, agentId, trigger, version)
}

beforeAll(async () => {
  app = await bootApp()
  sessions = await import('../../src/lib/harness-client/session.server')
  memories = await import('../../src/lib/db/memories.server')
  conversations = await import('../../src/lib/db/conversations.server')
  db = await import('../../src/lib/db/client.server')
  const { registerAgent } = await import('../../src/lib/harness-client/registry.server')
  const { compactExecution } =
    await import('@hames-ai/harness-patterns/patterns/compactExecution.server')
  const { bamlPatterns } = await import('@hames-ai/harness-baml/baml-patterns.server')
  const { withMemory } = await import('@hames-ai/harness-patterns/patterns/withMemory.server')
  const { simpleLoop } = await import('@hames-ai/harness-patterns/patterns/simpleLoop.server')
  const { createLoopControllerAdapter } =
    await import('@hames-ai/harness-baml/baml-adapters.server')
  const { Tools } = await import('@hames-ai/harness-patterns/tools.server')
  const { humanGate } = await import('@hames-ai/harness-patterns/hitl.server')
  answer = () =>
    compactExecution<SessionData>({ mode: 'message', synthesize: bamlPatterns().synthesize })
  for (const id of [AGENT, 'e2e-memory-pause', 'e2e-memory-held', 'e2e-memory-tools']) {
    registerAgent({
      id,
      name: id,
      description: 'Synthetic memory test',
      welcome: 'Synthetic memory test',
      servers: [],
      icon: 'i-material-symbols-rule',
      accent: 'indigo',
      createPatterns: async () => {
        const chain = [answer()]
        if (id.endsWith('tools') || id.endsWith('pause')) {
          const tools = await Tools({ namespaces: sessions.agentDeps().toolNamespaces })
          chain.unshift(simpleLoop<SessionData>(createLoopControllerAdapter(), tools.neo4j ?? []))
        }
        if (id.endsWith('pause'))
          chain.unshift(
            humanGate<SessionData>({
              request: () => ({
                kind: 'confirm',
                key: 'synthetic',
                question: 'Continue the synthetic turn?',
                options: [
                  { id: 'continue', label: 'Continue' },
                  { id: 'stop', label: 'Stop', stopsRun: true },
                ],
                defaultOption: 'continue',
                unattended: 'park',
              }),
            }),
          )
        if (id.endsWith('held')) {
          const step = answer()
          step.name = 'e2e-held-boundary'
          step.fn = async (scope) => {
            await gate?.()
            return scope
          }
          chain.unshift(step)
        }
        return withMemory<MemoryData>(sessions.agentDeps().memory!)(chain)
      },
    })
  }
  await memories.ensureMemoriesSchema()
  await app.wipe()
})
beforeEach(async () => {
  await app.wipe()
  app.fakeLlm.reset()
  gate = undefined
})
afterAll(async () => {
  await app.wipe()
})

describe.runIf(IS_HERMETIC)('scenario 10: memory through real turns', () => {
  it('runs both tiers', () => {
    expect([...TIERS].sort()).toEqual(['anthropic', 'verda'])
  })
  it('the browser wipe also removes memories before their conversation sources', async () => {
    const { wipeUserRows } = await import('../../e2e-browser/lib/db')
    const owner = 'e2e-browser-user'
    const id = newSessionId('browser-memory-wipe')
    const memoryId = randomUUID()
    await conversations.createConversation({
      id,
      userId: owner,
      agentId: AGENT,
      title: 'Synthetic wipe',
      serializedContext: '{}',
    })
    await memories.insertMemory({
      id: memoryId,
      userId: owner,
      kind: 'episodic',
      tier: 'anthropic',
      content: MESSAGE,
      evidence: MESSAGE,
      embedding: Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0)),
      embedSpace: 'synthetic',
    })
    await memories.insertMemorySource({
      userId: owner,
      memoryId,
      eventId: `synthetic-${memoryId}`,
      ordinal: 0,
      conversationId: id,
    })
    expect(await memories.listMemoriesForUser(owner)).toHaveLength(1)
    try {
      await wipeUserRows()
      expect(await memories.listMemoriesForUser(owner)).toEqual([])
      expect(await conversations.loadConversation(id, owner)).toBeNull()
    } finally {
      await memories.deleteAllMemoriesForUser(owner)
      await conversations.deleteConversation(id, owner)
    }
  })
  describe.each(TIERS)('on %s', (tier) => {
    beforeEach(async () => {
      await app.setTier(tier)
      await enabled(true)
    })
    it('answers over SSE before detached settle, persists memory_written, and prepends recall on the next conversation', async () => {
      const id = newSessionId('memory-write')
      app.fakeLlm.arm({ kind: 'hold', fn: 'ExtractMemory', times: 1 })
      try {
        const { status, frames } = await app.runTurnOverSse({
          sessionId: id,
          agentId: AGENT,
          message: MESSAGE,
        })
        expect(status).toBe(200)
        expect(frames.find((frame) => frame.event === 'done')?.data.response).toContain(
          'E2E-FAKE-ANSWER',
        )
        await waitFor(
          async () => app.fakeLlm.held,
          (held) => held.some((request) => request.fn === 'ExtractMemory'),
        )
        expect(await stored()).toHaveLength(0)
        expect(
          eventsOfType((await app.readRow(id))!.serializedContext, 'memory_written'),
        ).toHaveLength(0)
      } finally {
        app.fakeLlm.release()
        app.fakeLlm.disarm()
      }
      const row = await settled(id)
      const written = eventsOfType(row!.serializedContext, 'memory_written')
      expect(written).toEqual([expect.objectContaining({ tier, action: 'inserted' })])
      expect(await stored()).toEqual([
        expect.objectContaining({ tier, content: MESSAGE, evidence: MESSAGE }),
      ])
      const next = newSessionId('memory-recall')
      const offset = app.fakeLlm.calls.length
      await app.runTurnOverSse({
        sessionId: next,
        agentId: AGENT,
        message: 'What do you remember about my synthetic gardens?',
      })
      await settled(next)
      const recalled = JSON.parse((await app.readRow(next))!.serializedContext)
      expect(
        recalled.events.findIndex((e: { type: string }) => e.type === 'memory_recalled'),
      ).toBeLessThan(
        recalled.events.findIndex((e: { type: string }) => e.type === 'assistant_message'),
      )
      expect(
        eventsOfType((await app.readRow(next))!.serializedContext, 'memory_recalled')[0].attached,
      ).toEqual([written[0].memoryId])
      expect(
        app.fakeLlm.calls.slice(offset).find((call) => call.fn === 'Synthesize')?.prompt,
      ).toContain(MESSAGE)
      const extracts = app.fakeLlm.calls.filter((call) => call.fn === 'ExtractMemory')
      expect(extracts).toHaveLength(2)
      expect(
        extracts.every(
          (call) => call.model === (tier === 'verda' ? SMALL_MODEL : FAKE_ANTHROPIC_TIER_MODEL),
        ),
      ).toBe(true)
      if (tier === 'verda') {
        expect(
          app.fakeLlm.calls.filter(
            (call) =>
              call.model === 'typesafe/jev-1.13' || call.model === FAKE_ANTHROPIC_TIER_MODEL,
          ),
        ).toEqual([])
      }
      expect(await takeEgressAttempts()).toEqual([])
    })
    it('a disabled user recalls nothing and stores nothing even with existing memories', async () => {
      const id = newSessionId('memory-before-disabled')
      await app.runTurn(id, MESSAGE, AGENT)
      await settled(id)
      const before = await stored()
      await enabled(false)
      const offset = app.fakeLlm.calls.length
      const next = newSessionId('memory-disabled')
      await app.runTurn(
        next,
        'What do you remember about my synthetic gardens?',
        'e2e-memory-tools',
      )
      await settleSummaries(app, next)
      const blob = (await app.readRow(next))!.serializedContext
      expect(eventsOfType(blob, 'memory_recalled')).toEqual([
        expect.objectContaining({ attached: [], skipped: 'disabled' }),
      ])
      expect(
        app.fakeLlm.calls.slice(offset).find((call) => call.fn === 'Synthesize')?.prompt,
      ).not.toContain(MESSAGE)
      expect(eventsOfType(blob, 'memory_written')).toEqual([])
      expect(await stored()).toEqual(before)
      expect(app.fakeLlm.calls.slice(offset).filter((call) => call.fn === 'ExtractMemory')).toEqual(
        [],
      )
    })
    it('triggered turns exclude both recall and settle', async () => {
      const id = newSessionId('memory-triggered')
      await triggered(id, 'e2e-memory-tools')
      await settleSummaries(app, id)
      expect((await app.readRow(id))?.status).toBe('done')
      expect(await stored()).toEqual([])
      expect(
        app.fakeLlm.calls.filter(
          (call) =>
            call.fn === 'ExtractMemory' ||
            (call.outcome === 'wake' && call.model === 'Qwen3-Embedding-0.6B'),
        ),
      ).toEqual([])
      expect(eventsOfType((await app.readRow(id))!.serializedContext, 'memory_recalled')).toEqual([
        expect.objectContaining({ attached: [], skipped: 'disabled' }),
      ])
    })
    it.each(['interactive', 'triggered'] as const)(
      'a resumed %s run preserves the memory origin',
      async (origin) => {
        const id = newSessionId(`memory-resume-${origin}`)
        if (origin === 'interactive') await app.runTurn(id, MESSAGE, 'e2e-memory-pause')
        else await triggered(id, 'e2e-memory-pause')
        const row = (await app.readRow(id))!
        expect(row.status).toBe('paused')
        const requests = eventsOfType(row.serializedContext, 'hitl_request')
        expect(requests).toHaveLength(1)
        const { answerHitl } = await import('../../src/lib/hitl/actions.server')
        expect(await answerHitl(id, { [requests[0].requestId as string]: 'continue' })).toEqual([
          expect.objectContaining({ outcome: 'answered' }),
        ])
        const { frames } = await app.runTurnOverSse({ mode: 'resume', sessionId: id })
        expect(frames.find((frame) => frame.event === 'done')?.data.response).toContain(
          'E2E-FAKE-ANSWER',
        )
        await settleSummaries(app, id)
        if (origin === 'interactive') {
          await settled(id)
          expect(await stored()).toHaveLength(1)
        } else {
          expect(
            eventsOfType((await app.readRow(id))!.serializedContext, 'memory_written'),
          ).toEqual([])
          expect(await stored()).toEqual([])
          expect(app.fakeLlm.calls.filter((call) => call.fn === 'ExtractMemory')).toEqual([])
        }
      },
    )
    it('repairs a lost trailing save on the next load while a newer turn held the claim at commit', async () => {
      const id = newSessionId('memory-lost-save')
      let enter!: () => void
      let release!: () => void
      const entered = new Promise<void>((resolve) => {
        enter = resolve
      })
      const barrier = new Promise<void>((resolve) => {
        release = resolve
      })
      const errors = vi.spyOn(console, 'error')
      let newer: Promise<unknown> | undefined
      app.fakeLlm.arm({ kind: 'hold', fn: 'ExtractMemory', times: 1 })
      try {
        await app.runTurn(id, MESSAGE, 'e2e-memory-held')
        await waitFor(
          async () => app.fakeLlm.held,
          (held) => held.some((request) => request.fn === 'ExtractMemory'),
        )
        gate = async () => {
          enter()
          await barrier
        }
        newer = app.runTurn(id, 'Continue with the synthetic garden.', 'e2e-memory-held')
        await entered
        expect(await stored()).toEqual([])
        app.fakeLlm.release()
        app.fakeLlm.disarm()
        await waitFor(stored, (rows) => rows.length === 1)
        await waitFor(
          async () => errors.mock.calls,
          (calls) =>
            calls.some(
              (args) => String(args[0]).includes(id) && String(args[0]).includes('not saved'),
            ),
        )
        const raw = (await app.readRow(id))!
        expect(eventsOfType(raw.serializedContext, 'memory_written')).toEqual([])
        await enabled(false)
        release()
        await newer
        const loaded = (await sessions.loadSession(id, app.userId))!
        expect(eventsOfType(loaded.serializedContext, 'memory_written')).toEqual([
          expect.objectContaining({ action: 'reinforced', memoryId: (await stored())[0].id }),
        ])
        const again = (await sessions.loadSession(id, app.userId))!
        expect(eventsOfType(again.serializedContext, 'memory_written')).toHaveLength(1)
        expect(
          eventsOfType((await app.readRow(id))!.serializedContext, 'memory_written'),
        ).toHaveLength(1)
        expect(app.fakeLlm.calls.filter((call) => call.fn === 'ExtractMemory')).toHaveLength(1)
      } finally {
        release()
        app.fakeLlm.release()
        app.fakeLlm.disarm()
        await newer
        errors.mockRestore()
      }
    })
    it('erases the whole shared memory on conversation delete and an old surviving blob never resurrects it', async () => {
      const first = newSessionId('memory-source-one')
      const second = newSessionId('memory-source-two')
      await app.runTurn(first, MESSAGE, AGENT)
      await settled(first)
      await app.runTurn(second, MESSAGE, AGENT)
      await settled(second)
      const rows = await stored()
      expect(rows).toHaveLength(1)
      expect(rows[0].evidenceCount).toBe(2)
      const old = (await app.readRow(second))!.serializedContext
      expect(await memories.listMemorySourcesForConversation(second, app.userId)).toHaveLength(1)
      await conversations.deleteConversation(first, app.userId)
      expect(await app.readRow(first)).toBeNull()
      expect(await app.readRow(second)).not.toBeNull()
      expect(await stored()).toEqual([])
      expect(await memories.listMemorySourcesForConversation(second, app.userId)).toEqual([])
      const { reconcileMemoryReferences } = await import('../../src/lib/memory/reconcile.server')
      expect(await reconcileMemoryReferences(old, second, app.userId)).toBe(old)
      const missing = JSON.parse(old)
      missing.events = missing.events.filter(
        (event: { type: string }) => event.type !== 'memory_written',
      )
      const row = (await conversations.loadConversation(second, app.userId))!
      expect(
        await conversations.updateConversationContextIfUnchanged(
          second,
          app.userId,
          JSON.stringify(missing),
          row.version,
        ),
      ).toBe(true)
      const loaded = (await sessions.loadSession(second, app.userId))!
      expect(eventsOfType(loaded.serializedContext, 'memory_written')).toEqual([])
      expect(await stored()).toEqual([])
      expect(app.fakeLlm.calls.filter((call) => call.fn === 'ExtractMemory')).toHaveLength(2)
    })
    it('rolls memory erasure back when the conversation delete fails in the same transaction', async () => {
      const id = newSessionId('memory-erase-rollback')
      await app.runTurn(id, MESSAGE, AGENT)
      await settled(id)
      const before = await stored()
      await db.query(
        "CREATE FUNCTION e2e_refuse_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic delete refused'; END $$",
      )
      await db.query(
        'CREATE TRIGGER e2e_refuse_delete BEFORE DELETE ON conversations FOR EACH ROW EXECUTE FUNCTION e2e_refuse_delete()',
      )
      try {
        await expect(conversations.deleteConversation(id, app.userId)).rejects.toThrow(
          'synthetic delete refused',
        )
        expect(await stored()).toEqual(before)
        expect(await app.readRow(id)).not.toBeNull()
        expect(await memories.listMemorySourcesForConversation(id, app.userId)).toHaveLength(1)
      } finally {
        await db.query('DROP TRIGGER e2e_refuse_delete ON conversations')
        await db.query('DROP FUNCTION e2e_refuse_delete()')
      }
    })
    it('the following scenario can wipe rows after a memory-producing scenario', async () => {
      const id = newSessionId('memory-wipe')
      await app.runTurn(id, MESSAGE, AGENT)
      await settled(id)
      expect(await stored()).toHaveLength(1)
      await app.wipe()
      expect(await stored()).toEqual([])
      expect(await app.readRow(id)).toBeNull()
    })
    it('an agent without memory does not wake either memory box', async () => {
      const wake = await import('../../src/lib/inference/memory-wake.server')
      wake.resetMemoryWake()
      await app.goToSleep()
      const id = newSessionId('memory-nonopted')
      await app.runTurn(id, MESSAGE, 'search')
      // Search uses tools: its detached summaries must finish before the next reset.
      await settleSummaries(app, id)
      expect(await stored()).toEqual([])
      expect(app.fakeLlm.calls.filter((call) => call.fn === 'ExtractMemory')).toEqual([])
      expect(
        app.fakeLlm.calls.filter(
          (call) =>
            call.model === 'Qwen3-Embedding-0.6B' ||
            (call.outcome === 'wake' && call.model === SMALL_MODEL),
        ),
      ).toEqual([])
    })
  })
})

// ============================================================================
// #419 M6: the confirmation of a memory, through real turns and the real modules
// ============================================================================

describe.runIf(IS_HERMETIC)(
  'scenario 10b: a memory is proposed, then saved only by an approval',
  () => {
    let proposals: typeof import('../../src/lib/memory/proposals.server')
    beforeAll(async () => {
      proposals = await import('../../src/lib/memory/proposals.server')
    })
    const proposalRows = async (id: string) =>
      (
        await db.query<{ request_id: string; status: string; payload: string | null }>(
          `SELECT request_id, status, payload FROM hitl_requests WHERE session_id = $1`,
          [id],
        )
      ).rows
    const proposedTurn = async (label: string) => {
      const id = newSessionId(label)
      app.fakeLlm.memoryConfirm('ask')
      await app.runTurn(id, MESSAGE, AGENT)
      const row = await waitFor(
        () => app.readRow(id),
        (r) => !!r && eventsOfType(r.serializedContext, 'hitl_request').length > 0,
      )
      return {
        id,
        requestId: String(eventsOfType(row!.serializedContext, 'hitl_request')[0].requestId),
      }
    }

    describe.each(TIERS)('on %s', (tier) => {
      beforeEach(async () => {
        await app.setTier(tier)
        await enabled(true)
      })

      it('an ask proposes: nothing is written, the text is held encrypted and never rides the blob', async () => {
        const { id, requestId } = await proposedTurn('confirm-propose')
        expect(await stored()).toEqual([])
        const blob = (await app.readRow(id))!.serializedContext
        expect(eventsOfType(blob, 'memory_written')).toEqual([])
        expect(eventsOfType(blob, 'hitl_request')).toEqual([
          expect.objectContaining({ kind: 'memory.confirm', blocking: false, requestId }),
        ])
        // the memory text is in the held payload (ciphertext) and nowhere in the blob
        expect(JSON.stringify(eventsOfType(blob, 'hitl_request'))).not.toContain(
          'synthetic gardens',
        )
        const [held] = await proposalRows(id)
        expect(held.status).toBe('pending')
        expect(held.payload).not.toBeNull()
        expect(held.payload).not.toContain('synthetic gardens')

        const [view] = await proposals.listMemoryProposalsFor(app.userId, id)
        expect(view.requestId).toBe(requestId)
        expect(view.items.map((i) => [i.kind, i.content, i.effect])).toEqual([
          ['episodic', MESSAGE, 'new'],
        ])
        expect(await takeEgressAttempts()).toEqual([])
      })

      it('Save writes the item, records the person and the write in ONE saved context, and closes the row', async () => {
        const { id, requestId } = await proposedTurn('confirm-save')
        const out = await proposals.answerMemoryProposalFor(app.userId, id, requestId, 'save')
        expect(out).toEqual({ outcome: 'saved', written: 1, stale: 0 })
        expect(await stored()).toEqual([
          expect.objectContaining({ tier, content: MESSAGE, evidence: MESSAGE }),
        ])
        const blob = (await app.readRow(id))!.serializedContext
        expect(eventsOfType(blob, 'hitl_response')).toEqual([
          expect.objectContaining({
            requestId,
            choice: 'save',
            by: 'person',
            principal: app.userId,
          }),
        ])
        expect(eventsOfType(blob, 'memory_written')).toEqual([
          expect.objectContaining({ tier, action: 'inserted' }),
        ])
        expect(await proposalRows(id)).toEqual([
          expect.objectContaining({ request_id: requestId, status: 'applied', payload: null }),
        ])
        // an answered proposal is gone from the list and cannot be answered twice
        expect(await proposals.listMemoryProposalsFor(app.userId, id)).toEqual([])
        expect(await proposals.answerMemoryProposalFor(app.userId, id, requestId, 'save')).toEqual({
          outcome: 'unknown-request',
        })
        expect(await stored()).toHaveLength(1)
        expect(await takeEgressAttempts()).toEqual([])
      })

      it("Don't save writes nothing and still closes the proposal", async () => {
        const { id, requestId } = await proposedTurn('confirm-discard')
        expect(
          await proposals.answerMemoryProposalFor(app.userId, id, requestId, 'discard'),
        ).toEqual({ outcome: 'discarded' })
        expect(await stored()).toEqual([])
        const blob = (await app.readRow(id))!.serializedContext
        expect(eventsOfType(blob, 'hitl_response')).toEqual([
          expect.objectContaining({ choice: 'discard', by: 'person' }),
        ])
        expect(eventsOfType(blob, 'memory_written')).toEqual([])
      })

      it('a turn in flight refuses the answer (a conflict), and the retry after it saves once', async () => {
        const { id, requestId } = await proposedTurn('confirm-conflict')
        const claimed = await conversations.claimConversation(id, app.userId)
        expect(claimed).not.toBeNull()
        try {
          expect(
            await proposals.answerMemoryProposalFor(app.userId, id, requestId, 'save'),
          ).toEqual({
            outcome: 'conflict',
          })
        } finally {
          await conversations.releaseConversationClaim(id, app.userId, claimed!.version)
        }
        // the write that ran before the refused save is idempotent: the retry
        // finds its provenance row, writes nothing twice and records the reference
        expect(await stored()).toHaveLength(1)
        expect(await proposals.answerMemoryProposalFor(app.userId, id, requestId, 'save')).toEqual({
          outcome: 'saved',
          written: 1, // reported as what the answer put in memory (a duplicate of the first write)
          stale: 0,
        })
        expect(await stored()).toHaveLength(1)
        expect((await stored())[0].evidenceCount ?? 1).toBe(1)
        expect(
          eventsOfType((await app.readRow(id))!.serializedContext, 'memory_written'),
        ).toHaveLength(1)
      })

      it('a user who switched memory off in the meantime saves nothing, and may still decline', async () => {
        const { id, requestId } = await proposedTurn('confirm-off')
        await enabled(false)
        expect(await proposals.answerMemoryProposalFor(app.userId, id, requestId, 'save')).toEqual({
          outcome: 'memory-off',
        })
        expect(await stored()).toEqual([])
        expect(
          await proposals.answerMemoryProposalFor(app.userId, id, requestId, 'discard'),
        ).toEqual({ outcome: 'discarded' })
      })

      it('another user can neither see nor answer it', async () => {
        const { id, requestId } = await proposedTurn('confirm-foreign')
        expect(await proposals.listMemoryProposalsFor('someone-else', id)).toEqual([])
        expect(
          await proposals.answerMemoryProposalFor('someone-else', id, requestId, 'save'),
        ).toEqual({
          outcome: 'unknown-request',
        })
        expect(await stored()).toEqual([])
      })

      it('deleting the conversation takes the held payload with it', async () => {
        const { id } = await proposedTurn('confirm-delete')
        expect(await proposalRows(id)).toHaveLength(1)
        await conversations.deleteConversation(id, app.userId)
        expect(await proposalRows(id)).toEqual([])
      })
    })

    it('the org target still never proposes and never writes, with the seam wired', async () => {
      // The fake gate answers `personal_memory`; the org outcome is pinned at
      // layer 1 (`m6-org-never-proposes`). Here: no proposal row exists for a
      // turn whose gate said `skip` — a routine memory is written straight through.
      await app.setTier('verda')
      await enabled(true)
      app.fakeLlm.memoryConfirm('skip')
      const id = newSessionId('confirm-skip')
      await app.runTurn(id, MESSAGE, AGENT)
      await settled(id)
      expect(await stored()).toHaveLength(1)
      expect(await proposalRows(id)).toEqual([])
      expect(eventsOfType((await app.readRow(id))!.serializedContext, 'hitl_request')).toEqual([])
    })
  },
)
