/**
 * Org-knowledge hook, slice 4 (`docs/plan/org-knowledge-hook.md`): a real turn
 * through the real server path, then the person's answer, on both tiers.
 *
 * The turn's continuation settles the hook: the systemone gate (the fake picks
 * `add_to_organizational_kg`), the draft loop on the `orgDraft` role (the fake
 * returns one new Project), the validator, the proposal, the hold. Then the
 * answer the browser would send is applied through `answerOrgProposalFor`.
 * The graph is the in-memory adapter: this layer has no Neo4j, and the store
 * is swapped at `configureOrgGraphStore` exactly as the inference endpoint is.
 *
 * Pins: propose → add → the store holds the node with `createdBy` = the user,
 * and nothing is written before the answer; discard writes nothing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ConfiguredPattern } from '@hames-ai/harness-patterns'
import type { SessionData } from '../../src/lib/harness-client/session.server'
import { bootApp, eventsOfType, newSessionId, type AppHandles } from '../lib/app'
import { IS_HERMETIC, TIERS } from '../lib/mode'
import { FAKE_ORG_MESSAGE } from '../lib/fake-llm'

const AGENT = 'e2e-org-knowledge'
let app: AppHandles
let store: import('@hames-ai/harness-patterns/org-knowledge-store').MemoryOrgGraphStore
let proposals: typeof import('../../src/lib/org-graph/proposals.server')
let freshStore: () => void

async function waitFor<T>(read: () => Promise<T>, accepts: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 15_000
  for (;;) {
    const value = await read()
    if (accepts(value)) return value
    if (Date.now() > deadline) throw new Error('the org-knowledge continuation did not propose')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** Run the turn and wait for its continuation's proposal to be listed. */
async function proposed(sessionId: string) {
  const { status } = await app.runTurnOverSse({
    sessionId,
    agentId: AGENT,
    message: FAKE_ORG_MESSAGE,
  })
  expect(status).toBe(200)
  await waitFor(
    () => app.readRow(sessionId),
    (row) =>
      !!row &&
      eventsOfType(row.serializedContext, 'hitl_request').some(
        (data) => (data as { kind?: string }).kind === 'orgKnowledge.confirm',
      ),
  )
  const views = await proposals.listOrgProposalsFor(app.userId, sessionId)
  expect(views).toHaveLength(1)
  return views[0]
}

beforeAll(async () => {
  app = await bootApp()
  process.env.ORG_KNOWLEDGE_HOOK = 'on'
  const { createMemoryOrgGraphStore } =
    await import('@hames-ai/harness-patterns/org-knowledge-store')
  const { ORG_ONTOLOGY } = await import('../../src/lib/org-graph/ontology')
  const { configureOrgGraphStore } = await import('../../src/lib/org-graph/hook.server')
  proposals = await import('../../src/lib/org-graph/proposals.server')
  freshStore = () => {
    store = createMemoryOrgGraphStore(ORG_ONTOLOGY)
    configureOrgGraphStore(store)
  }
  freshStore()

  const { registerAgent } = await import('../../src/lib/harness-client/registry.server')
  const { compactExecution } =
    await import('@hames-ai/harness-patterns/patterns/compactExecution.server')
  const { bamlPatterns } = await import('@hames-ai/harness-baml/baml-patterns.server')
  const { withOrgKnowledge } = await import('@hames-ai/harness-patterns/org-knowledge-hook.server')
  registerAgent({
    id: AGENT,
    name: AGENT,
    description: 'Synthetic org-knowledge test',
    welcome: 'Synthetic org-knowledge test',
    servers: [],
    egressPolicy: 'local-only',
    icon: 'i-material-symbols-rule',
    accent: 'cyan',
    createPatterns: async () =>
      withOrgKnowledge()([
        compactExecution<SessionData>({ mode: 'message', synthesize: bamlPatterns().synthesize }),
      ]) as ConfiguredPattern<SessionData>[],
  } as never)
  await app.wipe()
})

beforeEach(async () => {
  await app.wipe()
  app.fakeLlm.reset()
  freshStore()
})

afterAll(async () => {
  delete process.env.ORG_KNOWLEDGE_HOOK
  const { configureOrgGraphStore } = await import('../../src/lib/org-graph/hook.server')
  configureOrgGraphStore(undefined)
  await app.wipe()
})

describe.runIf(IS_HERMETIC)('scenario 22: the org-knowledge hook through a real turn', () => {
  describe.each(TIERS)('on %s', (tier) => {
    beforeEach(async () => {
      await app.setTier(tier)
    })

    it('proposes after the reply, writes nothing until the answer, then writes with createdBy', async () => {
      const id = newSessionId(`org-add-${tier}`)
      const before = store.dump().nodes.length
      const view = await proposed(id)
      expect(view.items.map((i) => i.elements.map((e) => [e.label, e.name, e.verdict]))).toEqual([
        [['Project', 'Heron', 'new']],
      ])
      expect(store.dump().nodes).toHaveLength(before)

      const r = await proposals.answerOrgProposalFor(app.userId, id, view.requestId, {
        choice: 'add',
        flags: { [view.items[0].flag]: true },
      })
      expect(r).toMatchObject({ outcome: 'added', written: 1, stale: 0, failed: 0 })
      const heron = store.dump().nodes.filter((n) => n.properties.name === 'Heron')
      expect(heron).toHaveLength(1)
      expect(heron[0].properties.createdBy).toBe(app.userId)
      // Answered: no longer offered.
      expect(await proposals.listOrgProposalsFor(app.userId, id)).toEqual([])
    })

    it('writes nothing on discard', async () => {
      const id = newSessionId(`org-discard-${tier}`)
      const before = JSON.stringify(store.dump())
      const view = await proposed(id)
      expect(
        await proposals.answerOrgProposalFor(app.userId, id, view.requestId, 'discard'),
      ).toEqual({
        outcome: 'discarded',
      })
      expect(JSON.stringify(store.dump())).toBe(before)
    })
  })
})
