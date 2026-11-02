/** #507 slice 10, layer 2: what the Decide step is TOLD about the conversation's
 * documents, read at the decide request body the fake endpoint received, and back
 * from the saved conversation. Real stash code over an in-memory Redis emulation,
 * real database, real SSE turn. The tier line is the invariant: no uploaded file
 * name reaches the Anthropic tier's decisions host. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { bootApp, eventsOfType, newSessionId, settleSummaries, type AppHandles } from '../lib/app'
import { IS_HERMETIC } from '../lib/mode'
import type { CallTool } from '@hames-ai/harness-patterns/stash/document-store.server'

/** The subset of Redis the stash uses, with RedisJSON's answer to a bracket-union
 *  path (selector order, absent members skipped). */
function memoryRedis(): CallTool {
  const json = new Map<string, Record<string, unknown>>()
  const sets = new Map<string, Set<string>>()
  return async (name, args) => {
    const key = String(args.name ?? args.key)
    switch (name) {
      case 'json_set':
        json.set(key, JSON.parse(String(args.value)))
        return { success: true, data: 'OK' }
      case 'json_get': {
        const doc = json.get(key)
        if (!doc) return { success: true, data: null }
        const path = String(args.path)
        if (path === '$') return { success: true, data: [doc] }
        const members = [...path.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1])
        return {
          success: true,
          data: JSON.stringify(members.filter((m) => m in doc).map((m) => doc[m])),
        }
      }
      case 'sadd':
        sets.set(key, (sets.get(key) ?? new Set()).add(String(args.value)))
        return { success: true, data: 1 }
      case 'smembers':
        return { success: true, data: [...(sets.get(key) ?? [])] }
      case 'srem':
        sets.get(key)?.delete(String(args.value))
        return { success: true, data: 1 }
      case 'delete':
        json.delete(key)
        return { success: true, data: 1 }
      default:
        return { success: false, data: null, error: `memory redis: unhandled ${name}` }
    }
  }
}

const NOTES = 'lantern-notes.md'
const SALES = 'lantern-sales.csv'
const HIDDEN = 'hidden-roster.md'
const ARCHIVED = 'archived-roster.md'

let app: AppHandles
let documents: typeof import('@hames-ai/harness-patterns/stash/document-store.server')
let stash: typeof import('@hames-ai/harness-patterns/stash-transport.server')
let ownership: typeof import('../../src/lib/stash/ownership.server')
let prefs: typeof import('../../src/lib/db/user-prefs.server')
let uninstallGraph: (() => void) | undefined
beforeAll(async () => {
  app = await bootApp()
  documents = await import('@hames-ai/harness-patterns/stash/document-store.server')
  stash = await import('@hames-ai/harness-patterns/stash-transport.server')
  ownership = await import('../../src/lib/stash/ownership.server')
  prefs = await import('../../src/lib/db/user-prefs.server')
  uninstallGraph = await app.installGraphTools()
  await app.wipe()
})
beforeEach(async () => {
  await app.wipe()
  app.fakeLlm.reset()
  app.fakeGateway.reset()
})
afterAll(async () => {
  stash.resetStashTransport()
  uninstallGraph?.()
  await app.wipe()
})

/** A session owned by the suite's user, holding two visible and two excluded documents. */
async function sessionWithDocuments(tag: string): Promise<string> {
  const redis = memoryRedis()
  stash.registerStashTransport(() => redis)
  const sessionId = newSessionId(tag)
  expect(await ownership.claimSessionOwnership(sessionId, app.userId)).toBe(true)
  const base = { sessionId, ingestStatus: 'indexed' as const }
  await documents.storeDocument(
    { ...base, filename: SALES, mimeType: 'text/csv', content: 'region,revenue\nNorth,47\n' },
    redis,
  )
  await documents.storeDocument(
    { ...base, filename: NOTES, mimeType: 'text/markdown', content: 'Target count: 50.' },
    redis,
  )
  const hidden = await documents.storeDocument(
    { ...base, filename: HIDDEN, mimeType: 'text/markdown', content: 'x' },
    redis,
  )
  const archived = await documents.storeDocument(
    { ...base, filename: ARCHIVED, mimeType: 'text/markdown', content: 'x' },
    redis,
  )
  await documents.setDocumentFlags(sessionId, hidden.id, { hidden: true }, redis)
  await documents.setDocumentFlags(sessionId, archived.id, { archived: true }, redis)
  return sessionId
}

const decisions = (calls: AppHandles['fakeLlm']['calls']) =>
  calls.filter((c) => c.endpoint && JSON.parse(c.prompt).questions?.next_step)

/** The first decision's state as the endpoint received it, and as the saved
 *  conversation's `decision_made` event carries it. */
function firstDecision(
  app: AppHandles,
  row: { serializedContext: string },
  endpoint: 'jev' | 'private',
) {
  const sent = decisions(app.fakeLlm.calls).filter((c) => c.endpoint === endpoint)
  const events = (
    JSON.parse(row.serializedContext) as {
      events: Array<{ type: string; llmCall?: { rawInput?: string } }>
    }
  ).events.filter((e) => e.type === 'decision_made')
  return {
    requestState: JSON.parse(sent[0].prompt).state as string,
    persistedState: JSON.parse(events[0].llmCall!.rawInput!).state as string,
    requests: sent.length,
  }
}

describe.runIf(IS_HERMETIC)('the decide request and the documents', () => {
  it('private tier: the request lists the visible documents, and the saved event carries exactly that', async () => {
    await app.setTier('self_deployed')
    await app.goToSleep()
    const sessionId = await sessionWithDocuments('decide-docs-private')
    const { status, frames } = await app.runTurnOverSse({
      sessionId,
      agentId: 'general-next',
      message: 'How many Project nodes are in the knowledge graph?',
    })
    expect(status).toBe(200)
    expect(frames.find((f) => f.event === 'done')?.data.status, JSON.stringify(frames)).not.toBe(
      'error',
    )
    await settleSummaries(app, sessionId)
    const row = (await app.readRow(sessionId))!
    const { requestState, persistedState } = firstDecision(app, row, 'private')

    expect(requestState).toContain('Uploaded documents in this conversation:')
    expect(requestState).toContain(`- "${NOTES}" (Markdown, `)
    expect(requestState).toContain(`- "${SALES}" (CSV, `)
    expect(requestState).toContain('searchable')
    // Hidden and archived documents are off the list and out of the count.
    expect(requestState).not.toContain(HIDDEN)
    expect(requestState).not.toContain(ARCHIVED)
    expect(requestState).not.toMatch(/\bmore documents\b/)
    // Between the conversation and "This turn so far".
    expect(requestState.indexOf('Uploaded documents')).toBeLessThan(
      requestState.indexOf('This turn so far:'),
    )
    // What was persisted is what was sent (mutation: render the event's copy differently).
    expect(persistedState).toBe(requestState)
  })

  it('Anthropic tier: the request carries the count and NO uploaded file name', async () => {
    await app.setTier('anthropic')
    const sessionId = await sessionWithDocuments('decide-docs-anthropic')
    const { frames } = await app.runTurnOverSse({
      sessionId,
      agentId: 'general-next',
      message: 'How many Project nodes are in the knowledge graph?',
    })
    expect(frames.find((f) => f.event === 'done')?.data.status).not.toBe('error')
    await settleSummaries(app, sessionId)
    const row = (await app.readRow(sessionId))!
    const { requestState, persistedState, requests } = firstDecision(app, row, 'jev')

    expect(requests).toBeGreaterThan(0)
    expect(requestState).toContain('Uploaded documents in this conversation: 2 (names not shown)')
    // The invariant, at the body the decisions host received: every request
    // of the turn, not only the first, and the persisted copy.
    for (const c of decisions(app.fakeLlm.calls)) {
      for (const name of [NOTES, SALES, HIDDEN, ARCHIVED, 'lantern']) {
        expect(c.prompt).not.toContain(name)
      }
    }
    expect(persistedState).toBe(requestState)
    expect(JSON.stringify(JSON.parse(row.serializedContext).events)).not.toContain(SALES)
  })

  // Mutation: a view change that reads an earlier `decision_made` (or its
  // `llmCall`) back into the decide window. The saved blob keeps the names the
  // private turn sent; nothing may carry them onto the other tier.
  it.each(['retained', 'redacted'] as const)(
    'a private turn with %s call records, then an Anthropic turn sends no name',
    async (records) => {
      await app.setTier('self_deployed')
      await app.goToSleep()
      const memoryText = 'I prefer concise replies about synthetic gardens.'
      if (records === 'redacted') {
        await prefs.setMemoryEnabledForUser(app.userId, true)
        const seed = await sessionWithDocuments('decide-docs-memory-seed')
        await app.runTurn(seed, memoryText, 'general-next')
        await settleSummaries(app, seed)
        expect(
          eventsOfType((await app.readRow(seed))!.serializedContext, 'memory_written'),
        ).not.toEqual([])
        app.fakeLlm.reset()
        app.fakeGateway.reset()
      }
      const sessionId = await sessionWithDocuments('decide-docs-flip')
      const first = await app.runTurnOverSse({
        sessionId,
        agentId: 'general-next',
        message: 'How many Project nodes are in the knowledge graph?',
      })
      expect(first.frames.find((f) => f.event === 'done')?.data.status).not.toBe('error')
      await settleSummaries(app, sessionId)
      const afterFirst = (await app.readRow(sessionId))!
      const privateCalls = decisions(app.fakeLlm.calls)
      expect(privateCalls.length).toBeGreaterThan(0)
      for (const call of privateCalls) {
        expect(call.endpoint).toBe('private')
        const state = JSON.parse(call.prompt).state
        expect(state).toContain(SALES)
        expect(state).toContain(NOTES)
      }
      const recalled = eventsOfType(afterFirst.serializedContext, 'memory_recalled')
      expect(recalled).toHaveLength(1)
      if (records === 'retained') {
        // This premise must stay strong: actual earlier records hold both names.
        expect(recalled[0]).toMatchObject({ attached: [], skipped: 'disabled' })
        expect(afterFirst.serializedContext).toContain(SALES)
        expect(afterFirst.serializedContext).toContain(NOTES)
        const { requestState, persistedState } = firstDecision(app, afterFirst, 'private')
        expect(persistedState).toBe(requestState)
      } else {
        expect(recalled[0].attached).not.toEqual([])
        expect(JSON.parse(privateCalls[0].prompt).state).toContain(memoryText)
        const events = JSON.parse(afterFirst.serializedContext).events as Array<{
          type: string
          data: { key?: string }
          llmCall?: { variables: unknown; rawInput?: string }
        }>
        const nextSteps = events.filter(
          (e) => e.type === 'decision_made' && e.data.key === 'next_step',
        )
        expect(nextSteps).toHaveLength(privateCalls.length)
        for (const event of nextSteps) {
          expect(event.llmCall).toBeDefined()
          expect(event.llmCall!.variables).toEqual({})
          expect(event.llmCall!.rawInput).toBeUndefined()
        }
        expect(afterFirst.serializedContext).not.toContain(SALES)
        expect(afterFirst.serializedContext).not.toContain(NOTES)
      }

      await app.setTier('anthropic', sessionId)
      app.fakeLlm.reset()
      app.fakeGateway.reset()
      const second = await app.runTurnOverSse({
        sessionId,
        agentId: 'general-next',
        message: 'And how many Person nodes?',
      })
      expect(second.frames.find((f) => f.event === 'done')?.data.status).not.toBe('error')
      await settleSummaries(app, sessionId)
      const sent = decisions(app.fakeLlm.calls)
      expect(sent.length).toBeGreaterThan(0)
      for (const c of sent) {
        expect(c.endpoint).toBe('jev')
        for (const name of [NOTES, SALES, HIDDEN, ARCHIVED, 'lantern']) {
          expect(c.prompt).not.toContain(name)
        }
        expect(c.prompt).not.toContain(memoryText)
      }
      expect(JSON.parse(sent[0].prompt).state).toContain(
        'Uploaded documents in this conversation: 2 (names not shown)',
      )
    },
  )

  it("another user's turn on the first user's session id lists nothing", async () => {
    await app.setTier('anthropic')
    const sessionId = await sessionWithDocuments('decide-docs-foreign')
    // The suite's user owns the session (the claim above, in the real database);
    // another user's scope on the same session id gets nothing and no stash read.
    const { runWithUserId } = await import('../../src/lib/harness-client/request-user.server')
    const { createDecisionDocuments } =
      await import('../../src/lib/harness-client/decision-documents.server')
    const { withRunFrame } = await import('@hames-ai/harness-patterns/run-frame.server')
    const intruder = createDecisionDocuments(sessionId)
    const seen = await runWithUserId('someone-else', () =>
      withRunFrame({ inference: { tier: 'self_deployed' } }, () =>
        intruder(new AbortController().signal),
      ),
    )
    expect(seen).toEqual({ total: 0 })
  })
})
