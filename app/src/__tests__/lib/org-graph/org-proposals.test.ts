// @vitest-environment node
/**
 * `answerOrgProposalFor` (slice 4) over a real proposal (core's request and
 * payload) and the in-memory graph store. The database modules are doubles:
 * a conversation belongs to its owner only, and the row holds the payload.
 *
 * Pins, each with the mutation that reddens it:
 *  - a stale assertion is refused and the rest are written (mutation: refuse
 *    the whole answer when any item is stale);
 *  - another user's proposal is an unknown one (mutation: load the conversation
 *    without its owner);
 *  - discard writes nothing; `createdBy` is the answering user.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@hames-ai/harness-baml/baml-adapters.server', () => ({
  createDecideAdapter: () => vi.fn(),
  createLoopControllerAdapter: () => vi.fn(),
}))
vi.mock('../../../lib/org-graph/member-mentions.server', () => ({
  loadMemberMentions: async () => () => false,
}))

const rows = vi.hoisted(
  () => new Map<string, { conv: { serializedContext: string; version: number }; owner: string }>(),
)
const held = vi.hoisted(() => new Map<string, unknown>())
const saves = vi.hoisted(() => [] as string[])
vi.mock('../../../lib/db/conversations.server', () => ({
  loadConversation: async (id: string, userId: string) => {
    const r = rows.get(id)
    return r && r.owner === userId ? r.conv : null
  },
  updateConversationContextIfUnchanged: async (id: string, _u: string, ctx: string) => {
    saves.push(id)
    rows.get(id)!.conv.serializedContext = ctx
    return true
  },
}))
vi.mock('../../../lib/db/hitl.server', async (importActual) => ({
  ...(await importActual<typeof import('../../../lib/db/hitl.server')>()),
  getHitlProposal: async (requestId: string) =>
    held.has(requestId)
      ? {
          requestId,
          sessionId: 'conv-1',
          kind: 'orgKnowledge.confirm',
          payload: held.get(requestId),
          status: 'pending',
          answer: null,
          expiresAt: null,
        }
      : null,
  claimHitlProposalAnswer: async () => ({ claimed: true }),
  closeHitlRows: async () => 1,
  listHitlProposals: async () => [],
}))

import { createContext, serializeContext } from '@hames-ai/harness-patterns/context.server'
import { proposeToHuman } from '@hames-ai/harness-patterns/hitl.server'
import { orgKnowledgeConfirmRequest } from '@hames-ai/harness-patterns/org-knowledge-hook.server'
import {
  validateOrgDraft,
  type DraftElement,
} from '@hames-ai/harness-patterns/org-knowledge-validate.server'
import { createMemoryOrgGraphStore } from '@hames-ai/harness-patterns/org-knowledge-store'
import { configureOrgGraphStore } from '../../../lib/org-graph/hook.server'
import { answerOrgProposalFor } from '../../../lib/org-graph/proposals.server'
import { ORG_ONTOLOGY } from '../../../lib/org-graph/ontology'

const MSG = "We've started Project Heron, and Project Osprey's status is active."
const SEED = [
  {
    key: 'id:osprey',
    label: 'Project',
    properties: { id: 'osprey', name: 'Osprey', nameKey: 'osprey', status: 'on hold' },
  },
]
const node = (
  ref: string,
  name: string,
  extra: Record<string, string>,
  evidence: string,
  assertion: number,
): DraftElement => ({
  kind: 'node',
  ref,
  label: 'Project',
  properties: { name, ...extra },
  evidence,
  assertion,
})

async function proposal() {
  const store = createMemoryOrgGraphStore(ORG_ONTOLOGY, { nodes: SEED, edges: [] })
  configureOrgGraphStore(store)
  const snapshot = await store.snapshot({
    names: [
      { label: 'Project', name: 'Heron' },
      { label: 'Project', name: 'Osprey' },
    ],
    keys: [],
  })
  const v = validateOrgDraft(
    {
      elements: [
        node('h', 'Heron', {}, 'started Project Heron', 0),
        node('o', 'Osprey', { status: 'active' }, "Project Osprey's status is active", 1),
      ],
    },
    snapshot,
    ORG_ONTOLOGY,
    { userMessage: MSG, today: '2026-11-04', mentionsMember: () => false },
  )
  expect(v.rejected).toEqual({})
  const ctx = createContext(MSG)
  const eventId = ctx.events[0].id!
  const outcome = proposeToHuman(ctx, orgKnowledgeConfirmRequest(v.accepted, eventId), {
    attended: true,
  })
  if (outcome.status !== 'pending') throw new Error('not pending')
  held.set(outcome.requestId, {
    v: 1,
    tier: 'self_deployed',
    eventId,
    conversationId: 'conv-1',
    assertions: v.accepted,
  })
  rows.set('conv-1', {
    conv: { serializedContext: serializeContext(ctx), version: 1 },
    owner: 'alice',
  })
  return { store, requestId: outcome.requestId }
}

beforeEach(() => {
  rows.clear()
  held.clear()
  saves.length = 0
})

describe('answerOrgProposalFor', () => {
  it('writes the selected assertions with the answering user as createdBy, and saves once', async () => {
    const { store, requestId } = await proposal()
    const r = await answerOrgProposalFor('alice', 'conv-1', requestId, {
      choice: 'add',
      flags: { a0: true, a1: false },
    })
    expect(r).toMatchObject({ outcome: 'added', written: 1, stale: 0, failed: 0 })
    const heron = store.dump().nodes.find((n) => n.properties.name === 'Heron')!
    expect(heron.properties.createdBy).toBe('alice')
    expect(store.dump().nodes.find((n) => n.key === 'id:osprey')!.properties.status).toBe('on hold')
    expect(saves).toEqual(['conv-1'])
  })

  // Design pin: a stale assertion is refused and the rest are written.
  it('refuses a stale assertion and still writes the others', async () => {
    const { store, requestId } = await proposal()
    store.setProperty('id:osprey', 'status', 'cancelled') // another writer, after the preview
    const r = await answerOrgProposalFor('alice', 'conv-1', requestId, {
      choice: 'add',
      flags: { a0: true, a1: true },
    })
    expect(r).toMatchObject({ outcome: 'added', written: 1, stale: 1, failed: 0 })
    expect(store.dump().nodes.some((n) => n.properties.name === 'Heron')).toBe(true)
    expect(store.dump().nodes.find((n) => n.key === 'id:osprey')!.properties.status).toBe(
      'cancelled',
    )
  })

  it('writes nothing on discard', async () => {
    const { store, requestId } = await proposal()
    const before = store.dump()
    expect(await answerOrgProposalFor('alice', 'conv-1', requestId, 'discard')).toEqual({
      outcome: 'discarded',
    })
    expect(store.dump()).toEqual(before)
    expect(saves).toEqual(['conv-1'])
  })

  // Design pin: another user's proposal is refused.
  it('treats another user’s proposal as unknown and writes nothing', async () => {
    const { store, requestId } = await proposal()
    const before = store.dump()
    expect(
      await answerOrgProposalFor('bob', 'conv-1', requestId, {
        choice: 'add',
        flags: { a0: true, a1: true },
      }),
    ).toEqual({
      outcome: 'unknown-request',
    })
    expect(store.dump()).toEqual(before)
    expect(saves).toEqual([])
  })

  it('refuses a flag the request did not offer, before any write', async () => {
    const { store, requestId } = await proposal()
    const before = store.dump()
    const r = await answerOrgProposalFor('alice', 'conv-1', requestId, {
      choice: 'add',
      flags: { a9: true },
    })
    expect(r.outcome).toBe('invalid-flag')
    expect(store.dump()).toEqual(before)
  })
})
