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
 *  - slice 5: an acceptance returns what the tab draws, its own elements
 *    flagged `added` and named by who added them (mutation: drop `graph` from
 *    the outcome); the card names a merge's existing node and a removed edge's
 *    ends (mutation: pass the removed edges' keys through unresolved).
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
  listHitlProposals: async () =>
    [...held].map(([requestId, payload]) => ({
      requestId,
      sessionId: 'conv-1',
      kind: 'orgKnowledge.confirm',
      payload,
      status: 'pending',
      answer: null,
      expiresAt: null,
    })),
}))
vi.mock('../../../lib/auth/users.server', () => ({
  getUser: async (id: string) => (id === 'alice' ? { id, displayName: 'Alice Example' } : null),
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
import { answerOrgProposalFor, listOrgProposalsFor } from '../../../lib/org-graph/proposals.server'
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

async function proposal(
  msg = MSG,
  seed: { nodes: typeof SEED; edges: { type: string; from: string; to: string }[] } = {
    nodes: SEED,
    edges: [],
  },
  elements?: DraftElement[],
) {
  const store = createMemoryOrgGraphStore(ORG_ONTOLOGY, seed)
  configureOrgGraphStore(store)
  const snapshot = await store.snapshot({
    names: [
      { label: 'Project', name: 'Heron' },
      { label: 'Project', name: 'Osprey' },
      { label: 'Member', name: 'Tamsin Orrin' },
      { label: 'Theme', name: 'Theme 1' },
    ],
    keys: [],
  })
  const v = validateOrgDraft(
    {
      elements: elements ?? [
        node('h', 'Heron', {}, 'started Project Heron', 0),
        node('o', 'Osprey', { status: 'active' }, "Project Osprey's status is active", 1),
      ],
    },
    snapshot,
    ORG_ONTOLOGY,
    { userMessage: msg, today: '2026-11-04', mentionsMember: () => false },
  )
  expect(v.rejected).toEqual({})
  const ctx = createContext(msg)
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

describe('slice 5: what the card shows and what the tab draws', () => {
  const COORD = 'Tamsin Orrin has taken over as coordinator of Theme 1.'
  const coordinator = () =>
    proposal(
      COORD,
      {
        nodes: [
          {
            key: 'id:m-dorrit',
            label: 'Member',
            properties: { id: 'm-dorrit', displayName: 'Dorrit Wexley' },
          } as never,
          {
            key: 'id:m-tamsin',
            label: 'Member',
            properties: { id: 'm-tamsin', displayName: 'Tamsin Orrin' },
          } as never,
          {
            key: 'id:t-1',
            label: 'Theme',
            properties: { id: 't-1', name: 'Theme 1', nameKey: 'theme 1' },
          } as never,
        ],
        edges: [{ type: 'COORDINATES', from: 'id:m-dorrit', to: 'id:t-1' }],
      },
      [
        {
          kind: 'node',
          ref: 'm',
          label: 'Member',
          properties: { displayName: 'Tamsin Orrin' },
          evidence: 'Tamsin Orrin',
          assertion: 0,
        },
        {
          kind: 'node',
          ref: 't',
          label: 'Theme',
          properties: { name: 'Theme 1' },
          evidence: 'coordinator of Theme 1',
          assertion: 0,
        },
        {
          kind: 'edge',
          type: 'COORDINATES',
          from: 'm',
          to: 't',
          evidence: COORD.slice(0, -1),
          assertion: 0,
        },
      ],
    )

  it('names a merge’s existing node and a removed edge’s ends', async () => {
    await coordinator()
    const [view] = await listOrgProposalsFor('alice', 'conv-1')
    const els = view.items[0].elements
    expect(els.find((e) => e.label === 'Theme')).toMatchObject({
      verdict: 'reinforces',
      existing: 'Theme 1',
    })
    expect(els.find((e) => e.kind === 'edge')).toMatchObject({
      from: 'Tamsin Orrin',
      to: 'Theme 1',
      removes: [{ type: 'COORDINATES', from: 'Dorrit Wexley', to: 'Theme 1' }],
    })
  })

  it('an acceptance returns its elements flagged added, named by who added them, and their neighbours', async () => {
    const { store, requestId } = await proposal()
    const r = await answerOrgProposalFor('alice', 'conv-1', requestId, {
      choice: 'add',
      flags: { a0: true, a1: false },
    })
    if (r.outcome !== 'added') throw new Error(r.outcome)
    const heron = r.graph?.find((e) => e.data?.label === 'Heron')
    expect(heron?.data).toMatchObject({
      added: true,
      createdByName: 'Alice Example',
      type: 'Project',
    })
    // Keyed by the stored node's id, the key the extractor gives the same node from a read.
    const stored = store.dump().nodes.find((n) => n.properties.name === 'Heron')!
    expect(heron?.data?.id).toBe(stored.properties.id)
    // Osprey was not selected: neither written nor drawn.
    expect(r.graph?.some((e) => e.data?.label === 'Osprey')).toBe(false)
  })

  it('a replacement draws the new edge added and leaves the old one undrawn', async () => {
    const { requestId } = await coordinator()
    const r = await answerOrgProposalFor('alice', 'conv-1', requestId, {
      choice: 'add',
      flags: { a0: true },
    })
    if (r.outcome !== 'added') throw new Error(r.outcome)
    const edges = (r.graph ?? []).filter((e) => e.data?.kind === 'edge')
    expect(edges.map((e) => [e.data?.source, e.data?.target, e.data?.added])).toEqual([
      ['m-tamsin', 't-1', true],
    ])
    // Reinforced nodes are drawn, unmarked.
    expect(r.graph?.find((e) => e.data?.id === 't-1')?.data?.added).toBeUndefined()
  })
})
