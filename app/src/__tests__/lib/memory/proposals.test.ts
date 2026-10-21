/**
 * `lib/memory/proposals.server.ts` — the app half of memory confirmation (M6),
 * over the REAL core (`settleMemory` → `proposeToHuman` → `answerProposal` →
 * `applyMemoryProposal`) and a fake of the three things it touches: the
 * conversation row, the proposal rows and the memory store.
 *
 *   pr-bound         the blob, not the row, says what is open; an answer is bound
 *   pr-write         an approval writes what was proposed and nothing else
 *   pr-single-use    one version-checked save carries the answer; a refused save
 *                    costs a retry, never a double write
 *   pr-fail-closed   a failure, a switch-off, a purged payload: nothing answered
 *   pr-display       what reaches the popup is stripped and carries no vectors
 *
 * Every pin names the mutation that turns it red; each one was run.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}))

import {
  createContext,
  createEvent,
  serializeContext,
} from '@hames-ai/harness-patterns/context.server'
import { readProposals, expireHitl } from '@hames-ai/harness-patterns/hitl.server'
import { settleMemory } from '@hames-ai/harness-patterns/memory-store.server'
import type {
  DecideFn,
  HitlResponseEventData,
  MemoryProposalPayload,
  MemoryWriteStore,
  MemoryWriteTx,
  UnifiedContext,
} from '@hames-ai/harness-patterns'

// ---- the conversation row ---------------------------------------------------
let row: { serializedContext: string; version: string } | null
let convTitle: string | null = null
const loadConversation = vi.fn(async (..._a: unknown[]) =>
  row ? { ...row, id: 's1', userId: 'alice', title: convTitle } : null,
)
let casOk = true
/** A turn that saved the row while the answer was writing memories. */
let rowMovesOnDuringWrite = false
const updateConversationContextIfUnchanged = vi.fn(async (...a: unknown[]) => {
  if (!casOk) return false
  // The real statement: only if the row is still at the version named.
  if (row && a[3] !== row.version) return false
  row = { serializedContext: a[2] as string, version: `${a[3]}+1` }
  return true
})
vi.mock('../../../lib/db/conversations.server', () => ({
  loadConversation: (...a: unknown[]) => loadConversation(...a),
  updateConversationContextIfUnchanged: (...a: unknown[]) =>
    updateConversationContextIfUnchanged(...a),
}))

// ---- the proposal rows ------------------------------------------------------
type Held = {
  sessionId: string
  kind: string
  payload: unknown
  expiresAt: Date
  userId: string
  status?: 'pending' | 'answering'
  answer?: { choice: string; flags?: Record<string, boolean> } | null
}
const held = new Map<string, Held>()
const sessionIdReads: string[] = []
const claims: unknown[] = []
const releases: string[] = []
const closeHitlRows = vi.fn(async (ids: readonly string[], user: string, status: string) => {
  for (const id of ids) {
    const h = held.get(id)
    if (h && h.userId === user) held.delete(id)
  }
  void status
  return ids.length
})
vi.mock('../../../lib/db/hitl.server', async () => {
  const real = await vi.importActual<typeof import('../../../lib/db/hitl.server')>(
    '../../../lib/db/hitl.server',
  )
  const canonicalAnswer = real.canonicalAnswer
  return {
    ...real,
    putHitlProposal: async (i: Held & { requestId: string }) => {
      held.set(i.requestId, i)
    },
    getHitlProposal: async (id: string, user: string) => {
      const h = held.get(id)
      return h && h.userId === user
        ? {
            requestId: id,
            sessionId: h.sessionId,
            kind: h.kind,
            expiresAt: h.expiresAt,
            payload: h.payload,
            status: h.status ?? 'pending',
            answer: h.answer ?? null,
          }
        : null
    },
    // The real statement's semantics: pending → answering, once, fenced.
    claimHitlProposalAnswer: async (i: {
      requestId: string
      userId: string
      sessionId: string
      answer: { choice: string; flags?: Record<string, boolean> }
    }) => {
      claims.push(i.answer)
      const h = held.get(i.requestId)
      if (
        h &&
        h.userId === i.userId &&
        h.sessionId === i.sessionId &&
        (h.status ?? 'pending') === 'pending'
      ) {
        h.status = 'answering'
        h.answer = i.answer
        return { claimed: true }
      }
      return { claimed: false, recorded: h?.status === 'answering' ? (h.answer ?? null) : null }
    },
    // The real statement's semantics (#579 review 2a): given back only if no
    // memory_sources row exists for the proposal's source event.
    releaseHitlProposalAnswer: async (
      id: string,
      user: string,
      eventId: string,
      bound: { choice: string; flags?: Record<string, boolean> },
    ) => {
      const h = held.get(id)
      if (!h || h.userId !== user || h.status !== 'answering') return false
      if (!h.answer || canonicalAnswer(h.answer) !== canonicalAnswer(bound)) return false
      if ([...sources.keys()].some((k) => k.startsWith(`${eventId}#`))) return false
      releases.push(id)
      h.status = 'pending'
      h.answer = null
      return true
    },
    requireAnsweringBinding: async (
      _tx: unknown,
      id: string,
      user: string,
      bound: { choice: string; flags?: Record<string, boolean> },
    ) => {
      const h = held.get(id)
      if (
        !h ||
        h.userId !== user ||
        h.status !== 'answering' ||
        !h.answer ||
        canonicalAnswer(h.answer) !== canonicalAnswer(bound)
      ) {
        throw new Error('[hitl] the proposal answer is no longer bound')
      }
    },
    listProposalSessionIds: async (user: string, kind: string, limit: number) => (
      sessionIdReads.push(user),
      [
        ...new Set(
          [...held.values()]
            .filter((h) => h.userId === user && h.kind === kind)
            .map((h) => h.sessionId),
        ),
      ].slice(0, limit)
    ),
    listHitlProposals: async (sid: string, user: string, kind: string) =>
      [...held]
        .filter(([, h]) => h.sessionId === sid && h.userId === user && h.kind === kind)
        .map(([requestId, h]) => ({
          requestId,
          sessionId: h.sessionId,
          kind: h.kind,
          expiresAt: h.expiresAt,
          payload: h.payload,
          status: h.status ?? 'pending',
          answer: h.answer ?? null,
        })),
    closeHitlRows: (...a: [readonly string[], string, string]) => closeHitlRows(...a),
  }
})

// ---- the memory store and switch -------------------------------------------
interface Mem {
  id: string
  kind: string
  content: string
  count: number
}
let mems: Map<string, Mem>
let sources: Map<string, string>
let memoryOn = true
let storeFails = false
/** Fail every transaction after this many have run (null: never). */
let storeFailsAfter: number | null = null
let txRuns = 0
/** Flip the proposal back to pending as the write begins: a release that landed
 *  between the claim and this item's transaction (D3). */
let releaseBeforeWrite = false
/** Before the first item's transaction: a sibling releases and "Don't save" claims (D4). */
let reclaimAsDiscardBeforeWrite = false
const storeFor = (opts?: { inTransaction?: (tx: never) => Promise<void> }): MemoryWriteStore => ({
  async transaction(fn) {
    if (releaseBeforeWrite) for (const h of held.values()) h.status = 'pending'
    if (reclaimAsDiscardBeforeWrite) {
      for (const h of held.values()) {
        h.status = 'answering'
        h.answer = { choice: 'discard', flags: {} }
      }
    }
    await opts?.inTransaction?.({} as never)
    if (storeFails) throw new Error('db down')
    if (storeFailsAfter !== null && txRuns++ >= storeFailsAfter) throw new Error('db down')
    if (rowMovesOnDuringWrite && row) row = { ...row, version: 'v-newer' }
    const snap = {
      mems: new Map([...mems].map(([k, v]) => [k, { ...v }])),
      sources: new Map(sources),
    }
    const tx: MemoryWriteTx = {
      nearest: async () => null,
      insert: async (r) => {
        mems.set(r.id, { id: r.id, kind: r.kind, content: r.content, count: 1 })
      },
      reinforce: async (id) => {
        mems.get(id)!.count++
      },
      update: async (id, n) => {
        Object.assign(mems.get(id)!, { content: n.content })
        mems.get(id)!.count++
      },
      addSource: async (s) => {
        const k = `${s.eventId}#${s.ordinal}`
        if (sources.has(k)) return { inserted: false, memoryId: sources.get(k)! }
        sources.set(k, s.memoryId)
        return { inserted: true }
      },
      read: async (id) =>
        mems.has(id) ? { kind: mems.get(id)!.kind as never, content: mems.get(id)!.content } : null,
      count: async () => mems.size,
    }
    try {
      return await fn(tx)
    } catch (e) {
      mems = snap.mems
      sources = snap.sources
      throw e
    }
  },
})
vi.mock('../../../lib/db/memories.server', () => ({
  createMemoryDbStore: (_user: string, opts?: { inTransaction?: (tx: never) => Promise<void> }) =>
    storeFor(opts),
}))
const switchReads = vi.fn()
vi.mock('../../../lib/db/user-prefs.server', () => ({
  getMemoryEnabled: async () => (switchReads(), memoryOn),
}))
let space = 'space/1024'
vi.mock('../../../lib/memory/embedder.server', () => ({
  createMemoryEmbedder: () => ({ spaceId: space }),
}))

const {
  createMemoryConfirmSeam,
  listMemoryProposalsFor,
  answerMemoryProposalFor,
  listMemoryInboxFor,
} = await import('../../../lib/memory/proposals.server')

// ---- a proposed turn, made by the real settle ------------------------------
const SAID = 'I always prefer metric units, and my team is called Aurora.'
const confident = (labels: readonly { id: string }[], label: string) => ({
  probs: Object.fromEntries(
    labels.map((l) => [l.id, l.id === label ? 0.94 : 0.06 / Math.max(1, labels.length - 1)]),
  ),
  method: 'jev',
  calibrated: true,
})
const decide = (
  () => async (input: { spec: { key: string; labels: readonly { id: string }[] } }) => {
    const a: Record<string, string> = {
      'memory.store.target': 'personal_memory',
      'memory.store.confirm': 'ask',
      'memory.store.kind': 'preference',
      'memory.store.sensitive': 'ordinary',
    }
    return confident(input.spec.labels, a[input.spec.key] ?? 'distinct')
  }
)() as unknown as DecideFn

async function propose(
  candidates: Array<{ kind: string; content: string; evidence: string }> = [
    {
      kind: 'preference',
      content: 'The user prefers metric units.',
      evidence: 'I always prefer metric units',
    },
    {
      kind: 'trait',
      content: 'The user’s team is called Aurora.',
      evidence: 'my team is called Aurora',
    },
  ],
) {
  const ctx = createContext(SAID, {}, 's1')
  ctx.events.push(createEvent('assistant_message', 'x', { content: 'Noted.', final: true }))
  await settleMemory(
    ctx,
    {
      store: storeFor(),
      decide,
      extract: async () => ({ value: candidates as never, call: undefined as never }),
      embed: {
        spaceId: space,
        query: async () => [1, 0],
        documents: async (t: string[]) => t.map((_, i) => (i === 0 ? [1, 0] : [0, 1])),
      },
      owner: () => 'alice',
      tier: () => 'self_deployed',
      confirm: createMemoryConfirmSeam(() => 'alice'),
      settings: { enabled: () => true },
    },
    { conversationId: 's1' },
  )
  row = { serializedContext: serializeContext(ctx), version: 'v1' }
  return ctx
}

const requestId = () => {
  const ctx = JSON.parse(row!.serializedContext) as UnifiedContext
  return readProposals(ctx)[0].requestId
}
const memories = () => [...mems.values()].map((m) => m.content).sort()
const blob = () => JSON.parse(row!.serializedContext) as UnifiedContext
const responses = () =>
  blob()
    .events.filter((e) => e.type === 'hitl_response')
    .map((e) => e.data as HitlResponseEventData)

beforeEach(() => {
  vi.clearAllMocks()
  row = null
  casOk = true
  rowMovesOnDuringWrite = false
  held.clear()
  claims.length = 0
  releases.length = 0
  mems = new Map()
  sources = new Map()
  memoryOn = true
  convTitle = null
  sessionIdReads.length = 0
  switchReads.mockClear()
  storeFails = false
  storeFailsAfter = null
  txRuns = 0
  releaseBeforeWrite = false
  reclaimAsDiscardBeforeWrite = false
  space = 'space/1024'
})

describe('the hold', () => {
  // MUTATION: ignore `owner()` and hold under a constant → another user's rows → red.
  it('holds the prepared payload under the proposing user, in the proposing conversation', async () => {
    await propose()
    const [id] = [...held.keys()]
    expect(held.get(id)).toMatchObject({ userId: 'alice', sessionId: 's1', kind: 'memory.confirm' })
    expect((held.get(id)!.payload as MemoryProposalPayload).items).toHaveLength(2)
  })

  it('an unauthenticated settle holds nothing and the proposal is taken back', async () => {
    const seam = createMemoryConfirmSeam(() => null)
    await expect(
      seam.hold({ requestId: 'r', expiresAt: 1, payload: {} as MemoryProposalPayload }),
    ).rejects.toThrow('needs an owner')
  })
})

describe('pr-display', () => {
  // MUTATION: return `i.content` raw → a bidi override reaches the popup → red.
  it('strips format and control characters, and carries no vector and no memory id', async () => {
    // Acceptance already refuses hidden characters (its `sanitizer` rule), so
    // the strip is the second line: a held payload that carries them anyway.
    await propose([
      {
        kind: 'preference',
        content: 'The user prefers metric units.',
        evidence: 'I always prefer metric units',
      },
    ])
    const id = requestId()
    const h = held.get(id)!
    const payload = h.payload as MemoryProposalPayload
    held.set(id, {
      ...h,
      payload: {
        ...payload,
        items: [{ ...payload.items[0], content: 'The user prefers metric units.\u202E\u200B' }],
      },
    })
    const [view] = await listMemoryProposalsFor('alice', 's1')
    expect(view.items).toEqual([
      {
        ref: 'i0',
        kind: 'preference',
        content: 'The user prefers metric units.',
        evidence: 'I always prefer metric units',
        effect: 'new',
      },
    ])
    expect(JSON.stringify(view)).not.toMatch(/embedding|mem-/)
    expect(view.expiresAt).toBeGreaterThan(Date.now())
  })

  // MUTATION: list every row for the session → a row the blob does not hold open is offered → red.
  it('offers only what the blob holds open — not a row of its own', async () => {
    await propose()
    held.set('ghost', { ...[...held.values()][0], userId: 'alice' })
    const ids = (await listMemoryProposalsFor('alice', 's1')).map((v) => v.requestId)
    expect(ids).toEqual([requestId()])
  })

  it('offers nothing for a purged, foreign-conversation or malformed payload', async () => {
    await propose()
    const id = requestId()
    const h = held.get(id)!
    held.set(id, { ...h, payload: { ...(h.payload as object), conversationId: 'other' } })
    expect(await listMemoryProposalsFor('alice', 's1')).toEqual([])
    held.set(id, { ...h, payload: { v: 1 } })
    expect(await listMemoryProposalsFor('alice', 's1')).toEqual([])
    held.delete(id)
    expect(await listMemoryProposalsFor('alice', 's1')).toEqual([])
  })

  it('is another user’s nothing: no conversation, no proposals', async () => {
    await propose()
    expect(await listMemoryProposalsFor('mallory', 's1')).toEqual([])
  })

  // MUTATION: drop the lazy expiry → the blob keeps an open request past its time → red.
  it('closes an expired proposal in the blob and its row, once', async () => {
    await propose()
    const id = requestId()
    const ctx = blob()
    const req = ctx.events.find((e) => e.type === 'hitl_request')!.data as { expiresAt: number }
    req.expiresAt = Date.now() - 1
    row = { serializedContext: serializeContext(ctx), version: 'v1' }
    expect(await listMemoryProposalsFor('alice', 's1')).toEqual([])
    expect(responses()).toEqual([
      expect.objectContaining({ requestId: id, choice: null, by: 'expired' }),
    ])
    expect(closeHitlRows).toHaveBeenCalledWith([id], 'alice', 'expired')
    expect(expireHitl(row!.serializedContext, Date.now())).toBeNull()
  })
})

describe('inbox (#433 S8): the proposals waiting across conversations', () => {
  // MUTATION: drop the memory-switch check in listMemoryInboxFor → a switched-off memory's proposals are listed → red.
  it('lists one entry per open proposal, with a count and a stripped title, never memory text', async () => {
    await propose()
    convTitle = 'Metric\u202E units\u200B'
    const entries = await listMemoryInboxFor('alice')
    expect(entries).toEqual([
      {
        sessionId: 's1',
        requestId: requestId(),
        title: 'Metric units',
        itemCount: 2,
        expiresAt: expect.any(Number),
      },
    ])
    expect(JSON.stringify(entries)).not.toContain('metric units.')
    expect(JSON.stringify(entries)).not.toContain('Aurora')
  })

  // F3. MUTATION: load the conversation again for its title / re-read the switch per conversation → red.
  it('F3: costs one blob load per conversation and one switch read in all', async () => {
    await propose()
    loadConversation.mockClear()
    switchReads.mockClear()
    await listMemoryInboxFor('alice')
    expect(loadConversation).toHaveBeenCalledTimes(1)
    expect(switchReads).toHaveBeenCalledTimes(1)
  })

  it('is empty with memory off, and reads nothing at all', async () => {
    await propose()
    memoryOn = false
    loadConversation.mockClear()
    expect(await listMemoryInboxFor('alice')).toEqual([])
    expect(sessionIdReads).toEqual([])
    expect(loadConversation).not.toHaveBeenCalled()
  })

  // MUTATION: list rows without asking the blob (skip listMemoryProposalsFor) → a ghost row is listed → red.
  it('lists only what the blob holds open, and nothing for another owner', async () => {
    await propose()
    held.set('ghost', { ...[...held.values()][0], userId: 'alice' })
    expect((await listMemoryInboxFor('alice')).map((e) => e.requestId)).toEqual([requestId()])
    expect(await listMemoryInboxFor('mallory')).toEqual([])
  })

  it('an answered proposal leaves the inbox (erased ones disappear)', async () => {
    await propose()
    await answerMemoryProposalFor('alice', 's1', requestId(), 'discard')
    expect(await listMemoryInboxFor('alice')).toEqual([])
  })
})

describe('pr-bound', () => {
  // MUTATION: look the request up in the ROW instead of the blob → a row with no
  // proposal event can be answered into the blob → red.
  it('an answer to a row the blob does not hold open is refused, and nothing is written', async () => {
    await propose()
    const ctx = blob()
    ctx.events = ctx.events.filter((e) => e.type !== 'hitl_request')
    row = { serializedContext: serializeContext(ctx), version: 'v1' }
    const out = await answerMemoryProposalFor('alice', 's1', [...held.keys()][0], 'save')
    expect(out).toEqual({ outcome: 'unknown-request' })
    expect(memories()).toEqual([])
    expect(updateConversationContextIfUnchanged).not.toHaveBeenCalled()
  })

  it.each([
    ['an unknown id', 'nope'],
    ['a prototype key', '__proto__'],
  ])('%s is unknown', async (_n, id) => {
    await propose()
    expect(await answerMemoryProposalFor('alice', 's1', id, 'save')).toEqual({
      outcome: 'unknown-request',
    })
  })

  // MUTATION: load the conversation without `user_id` scoping (the fake models it
  // by returning another user's row) → a foreign proposal is answered → red.
  it('another user’s conversation is an unknown request', async () => {
    await propose()
    const id = requestId()
    loadConversation.mockResolvedValueOnce(null)
    expect(await answerMemoryProposalFor('mallory', 's1', id, 'save')).toEqual({
      outcome: 'unknown-request',
    })
    expect(memories()).toEqual([])
  })

  // MUTATION: drop the row's `user_id` fence (getHitlProposal ignores the owner) → red.
  it('a payload held for ANOTHER user is unavailable, never applied', async () => {
    await propose()
    const id = requestId()
    held.set(id, { ...held.get(id)!, userId: 'bob' })
    expect(await answerMemoryProposalFor('alice', 's1', id, 'save')).toEqual({
      outcome: 'unavailable',
    })
    expect(memories()).toEqual([])
  })

  // MUTATION: skip the expiry check → a proposal past due is answered → red.
  it('an expired proposal is refused as expired', async () => {
    await propose()
    const id = requestId()
    const ctx = blob()
    ;(ctx.events.find((e) => e.type === 'hitl_request')!.data as { expiresAt: number }).expiresAt =
      Date.now() - 1
    row = { serializedContext: serializeContext(ctx), version: 'v1' }
    expect(await answerMemoryProposalFor('alice', 's1', id, 'save')).toEqual({ outcome: 'expired' })
    expect(memories()).toEqual([])
  })

  // MUTATION: map a core refusal to success, or let it through unchecked → red.
  it.each([
    ['a choice nobody offered', 'nuke', 'invalid-choice'],
    ['an item the proposal never had', { choice: 'save', flags: { i9: true } }, 'invalid-flag'],
    ['a non-boolean flag', { choice: 'save', flags: { i0: 'yes' } }, 'invalid-flag'],
  ])('%s is refused by core against the request event', async (_n, answer, outcome) => {
    await propose()
    expect(await answerMemoryProposalFor('alice', 's1', requestId(), answer as never)).toEqual({
      outcome,
    })
    expect(memories()).toEqual([])
    expect(updateConversationContextIfUnchanged).not.toHaveBeenCalled()
  })

  // MUTATION: a payload from the CLIENT (the answer carries it): the type refuses
  // extra keys at the RPC; here core ignores them → the held payload still wins.
  it('what is written is the HELD payload, whatever else the answer carries', async () => {
    await propose()
    await answerMemoryProposalFor('alice', 's1', requestId(), {
      choice: 'save',
      payload: { items: [{ content: 'EVIL' }] },
    } as never)
    expect(memories().join()).not.toContain('EVIL')
  })
})

describe('pr-write', () => {
  // MUTATION: ignore the flags and write every item → red.
  it('saves the checked items only, and records the answer and the writes in ONE save', async () => {
    await propose()
    const id = requestId()
    const out = await answerMemoryProposalFor('alice', 's1', id, {
      choice: 'save',
      flags: { i0: true, i1: false },
    })
    expect(out).toEqual({ outcome: 'saved', written: 1, stale: 0 })
    expect(memories()).toEqual(['The user prefers metric units.'])
    expect(updateConversationContextIfUnchanged).toHaveBeenCalledTimes(1)
    const saved = blob()
    expect(responses()).toEqual([
      expect.objectContaining({
        requestId: id,
        choice: 'save',
        by: 'person',
        principal: 'alice',
        flags: { i0: true, i1: false },
      }),
    ])
    expect(saved.events.filter((e) => e.type === 'memory_written')).toHaveLength(1)
    expect(readProposals(saved)).toEqual([])
  })

  // MUTATION: take `principal` from the client → red (the answer type has no such key,
  // and core stamps what the host passes).
  it('stamps the session user as principal', async () => {
    await propose()
    await answerMemoryProposalFor('alice', 's1', requestId(), 'discard')
    expect(responses()[0]).toMatchObject({ principal: 'alice', by: 'person' })
  })

  // MUTATION: apply on discard → red.
  it('discard writes nothing, records the choice, and closes the row', async () => {
    await propose()
    const id = requestId()
    expect(await answerMemoryProposalFor('alice', 's1', id, 'discard')).toEqual({
      outcome: 'discarded',
    })
    expect(memories()).toEqual([])
    expect(sources.size).toBe(0)
    expect(responses()[0]).toMatchObject({ choice: 'discard' })
    expect(closeHitlRows).toHaveBeenCalledWith([id], 'alice', 'applied')
    expect(held.has(id)).toBe(false)
  })

  it('save with nothing checked writes nothing (the popup does not offer it)', async () => {
    await propose()
    const out = await answerMemoryProposalFor('alice', 's1', requestId(), {
      choice: 'save',
      flags: { i0: false, i1: false },
    })
    expect(out).toEqual({ outcome: 'saved', written: 0, stale: 0 })
    expect(memories()).toEqual([])
  })

  // MUTATION: drop the stale check in core's apply → the newer row is overwritten → red.
  it('reports an item that changed under the proposal as stale, and writes the rest', async () => {
    const ctx = await propose()
    void ctx
    const id = requestId()
    const h = held.get(id)!
    const payload = h.payload as MemoryProposalPayload
    mems.set('m-old', { id: 'm-old', kind: 'preference', content: 'Edited since.', count: 1 })
    held.set(id, {
      ...h,
      payload: {
        ...payload,
        items: [
          { ...payload.items[0], dedupe: { updates: 'm-old', expectedContent: 'Original.' } },
          payload.items[1],
        ],
      },
    })
    const out = await answerMemoryProposalFor('alice', 's1', id, 'save')
    expect(out).toEqual({ outcome: 'saved', written: 1, stale: 1 })
    expect(mems.get('m-old')!.content).toBe('Edited since.')
  })
})

describe('pr-single-use', () => {
  // MUTATION: pass an unconditional save / a stale version → red (A3's cousin).
  it('names the version it read, so a moved-on row refuses the save', async () => {
    await propose()
    await answerMemoryProposalFor('alice', 's1', requestId(), 'discard')
    expect(updateConversationContextIfUnchanged.mock.calls[0].slice(0, 2)).toEqual(['s1', 'alice'])
    expect(updateConversationContextIfUnchanged.mock.calls[0][3]).toBe('v1')
  })

  // MUTATION: name a version read AFTER the write (re-read the row) instead of
  // the one the answer started from → the newer turn's context is overwritten → red.
  it('a turn that saved the row during the write refuses ours: the newer context stands', async () => {
    await propose()
    const id = requestId()
    rowMovesOnDuringWrite = true
    const newer = row
    expect(await answerMemoryProposalFor('alice', 's1', id, 'save')).toEqual({
      outcome: 'conflict',
    })
    expect(row!.version).toBe('v-newer')
    expect(row!.serializedContext).toBe(newer!.serializedContext)
    expect(closeHitlRows).not.toHaveBeenCalled()
  })

  // MUTATION: close the row / report success when the save was refused → red.
  it('a refused save is a conflict: nothing is closed, and the retry writes nothing twice', async () => {
    await propose()
    const id = requestId()
    casOk = false
    expect(await answerMemoryProposalFor('alice', 's1', id, 'save')).toEqual({
      outcome: 'conflict',
    })
    expect(closeHitlRows).not.toHaveBeenCalled()
    expect(held.has(id)).toBe(true)
    expect(responses()).toEqual([])
    const afterFirst = memories()
    expect(afterFirst).toHaveLength(2)

    casOk = true
    const retry = await answerMemoryProposalFor('alice', 's1', id, 'save')
    // reported as what the answer put in memory: both items, as duplicates
    expect(retry).toEqual({ outcome: 'saved', written: 2, stale: 0 })
    expect(memories()).toEqual(afterFirst)
    expect([...mems.values()].every((m) => m.count === 1)).toBe(true)
    // the retry re-recorded the references the first save never landed
    expect(blob().events.filter((e) => e.type === 'memory_written')).toHaveLength(2)
    expect(responses()).toHaveLength(1)
  })

  // MUTATION: look in the journal instead of the open set → a second answer is recorded → red.
  it('a second answer after a landed one is unknown', async () => {
    await propose()
    const id = requestId()
    await answerMemoryProposalFor('alice', 's1', id, 'save')
    expect(await answerMemoryProposalFor('alice', 's1', id, 'discard')).toEqual({
      outcome: 'unknown-request',
    })
    expect(responses()).toHaveLength(1)
  })
})

describe('pr-fail-closed', () => {
  // MUTATION: save the context although a write failed → "answered" with nothing written → red.
  it('a store failure answers nothing and is retryable', async () => {
    await propose()
    const id = requestId()
    storeFails = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      expect(await answerMemoryProposalFor('alice', 's1', id, 'save')).toEqual({
        outcome: 'failed',
      })
    } finally {
      warn.mockRestore()
    }
    expect(updateConversationContextIfUnchanged).not.toHaveBeenCalled()
    expect(readProposals(blob())).toHaveLength(1)
    storeFails = false
    expect((await answerMemoryProposalFor('alice', 's1', id, 'save')).outcome).toBe('saved')
  })

  // MUTATION: drop the in-transaction switch read → red.
  it('a switched-off memory writes and answers nothing, and "don\'t save" still works', async () => {
    await propose()
    const id = requestId()
    memoryOn = false
    expect(await answerMemoryProposalFor('alice', 's1', id, 'save')).toEqual({
      outcome: 'memory-off',
    })
    expect(memories()).toEqual([])
    expect(updateConversationContextIfUnchanged).not.toHaveBeenCalled()
    expect(await answerMemoryProposalFor('alice', 's1', id, 'discard')).toEqual({
      outcome: 'discarded',
    })
  })

  // MUTATION: drop the embed-space comparison → red.
  it('vectors from another embedding space cannot be saved', async () => {
    await propose()
    space = 'other/768'
    expect(await answerMemoryProposalFor('alice', 's1', requestId(), 'save')).toEqual({
      outcome: 'unavailable',
    })
    expect(memories()).toEqual([])
  })

  it('a purged payload cannot be saved', async () => {
    await propose()
    const id = requestId()
    held.delete(id)
    expect(await answerMemoryProposalFor('alice', 's1', id, 'save')).toEqual({
      outcome: 'unavailable',
    })
  })

  // MUTATION: let a non-HitlAnswerError be mapped to an outcome → a bug is hidden → red.
  it('an unexpected error is not turned into an outcome', async () => {
    await propose()
    loadConversation.mockRejectedValueOnce(new Error('pool exhausted'))
    await expect(answerMemoryProposalFor('alice', 's1', requestId(), 'save')).rejects.toThrow(
      'pool exhausted',
    )
  })
})

// ============================================================================
// #579 fix round 1
// ============================================================================

describe('review 2: the answer is bound BEFORE the write', () => {
  // RV1. MUTATION: drop `claimHitlProposalAnswer` (or let a different answer
  // continue) → "Don't save" is recorded over two written memories → red.
  it('RV1 · a refused save, then "Don\'t save": the first answer stands and the second writes and records nothing', async () => {
    await propose()
    const id = requestId()
    casOk = false
    expect(await answerMemoryProposalFor('alice', 's1', id, 'save')).toEqual({
      outcome: 'conflict',
    })
    casOk = true
    expect(await answerMemoryProposalFor('alice', 's1', id, 'discard')).toEqual({
      outcome: 'already-answered',
    })
    expect(responses()).toEqual([])
    // the memories written under the bound save are still there, and the save can be finished
    expect(memories()).toHaveLength(2)
    expect(await answerMemoryProposalFor('alice', 's1', id, 'save')).toEqual({
      outcome: 'saved',
      written: 2,
      stale: 0,
    })
    expect(responses()).toEqual([expect.objectContaining({ choice: 'save' })])
  })

  // RV2. MUTATION: compare only the choice, not the flags → the unchecked item stays written → red.
  it('RV2 · a refused save of both, then a save of one: the second is a different answer', async () => {
    await propose()
    const id = requestId()
    casOk = false
    await answerMemoryProposalFor('alice', 's1', id, 'save')
    casOk = true
    expect(
      await answerMemoryProposalFor('alice', 's1', id, {
        choice: 'save',
        flags: { i0: true, i1: false },
      }),
    ).toEqual({ outcome: 'already-answered' })
    expect(responses()).toEqual([])
  })

  // RV3. MUTATION: drop the claim → both run, "discard" is recorded, both memories written → red.
  it('RV3 · two answers at once from one version: exactly one is bound, the other writes nothing', async () => {
    await propose()
    const id = requestId()
    const [a, b] = await Promise.all([
      answerMemoryProposalFor('alice', 's1', id, 'save'),
      answerMemoryProposalFor('alice', 's1', id, 'discard'),
    ])
    const outcomes = [a.outcome, b.outcome].sort()
    expect(outcomes).toContain('already-answered')
    const bound = claims[0] as { choice: string }
    // whoever won, the record and the memories agree
    if (bound.choice === 'save') expect(memories()).toHaveLength(2)
    else expect(memories()).toEqual([])
    for (const r of responses()) expect(r.choice).toBe(bound.choice)
  })

  // MUTATION: byte-compare nothing (accept any recorded answer) → red (RV1/RV2); and
  // key order must not matter.
  it('a retry of the same answer is the same answer whatever order its flags came in', async () => {
    await propose()
    const id = requestId()
    casOk = false
    await answerMemoryProposalFor('alice', 's1', id, {
      choice: 'save',
      flags: { i0: true, i1: false },
    })
    casOk = true
    const out = await answerMemoryProposalFor('alice', 's1', id, {
      choice: 'save',
      flags: { i1: false, i0: true },
    })
    expect(out).toEqual({ outcome: 'saved', written: 1, stale: 0 })
  })

  // MUTATION: report `written` only → a retry says "Saved 0." → red.
  it('a retry reports what the answer put in memory, duplicates included', async () => {
    await propose()
    const id = requestId()
    casOk = false
    await answerMemoryProposalFor('alice', 's1', id, 'save')
    casOk = true
    expect(await answerMemoryProposalFor('alice', 's1', id, 'save')).toMatchObject({
      outcome: 'saved',
      written: 2,
    })
  })

  // MUTATION: never release → a refusal before any write makes "Don't save" impossible → red.
  it.each([
    ['memory off', () => (memoryOn = false), 'memory-off'],
    ['another embedding space', () => (space = 'other/768'), 'unavailable'],
    ['a failing store', () => (storeFails = true), 'failed'],
  ])(
    '%s before any write gives the answer back, so the person can still decline',
    async (_n, setup, outcome) => {
      await propose()
      const id = requestId()
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        setup()
        expect((await answerMemoryProposalFor('alice', 's1', id, 'save')).outcome).toBe(outcome)
      } finally {
        warn.mockRestore()
      }
      expect(releases).toEqual([id])
      expect(held.get(id)!.status).toBe('pending')
      memoryOn = true
      storeFails = false
      expect((await answerMemoryProposalFor('alice', 's1', id, 'discard')).outcome).toBe(
        'discarded',
      )
    },
  )

  // MUTATION: release unconditionally → the bound save is dropped after writes → red (RV1 with a failure).
  it('a failure AFTER some item was written keeps the answer bound', async () => {
    await propose()
    const id = requestId()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      storeFailsAfter = 1 // the first item commits, the second fails
      const out = await answerMemoryProposalFor('alice', 's1', id, 'save')
      expect(out.outcome).toBe('failed')
    } finally {
      storeFailsAfter = null
      warn.mockRestore()
    }
    expect(releases).toEqual([])
    expect(held.get(id)!.status).toBe('answering')
    expect(await answerMemoryProposalFor('alice', 's1', id, 'discard')).toEqual({
      outcome: 'already-answered',
    })
  })

  it('an approval at M3’s hard limit writes nothing, says full, and gives the answer back', async () => {
    await propose()
    const id = requestId()
    for (let i = 0; i < 400; i++)
      mems.set(`x${i}`, { id: `x${i}`, kind: 'semantic', content: `c${i}`, count: 1 })
    expect(await answerMemoryProposalFor('alice', 's1', id, 'save')).toEqual({ outcome: 'full' })
    expect(memories()).toHaveLength(400)
    expect(held.get(id)!.status).toBe('pending')
  })

  it('the popup is told which answer is bound', async () => {
    await propose()
    const id = requestId()
    casOk = false
    await answerMemoryProposalFor('alice', 's1', id, {
      choice: 'save',
      flags: { i0: true, i1: false },
    })
    casOk = true
    const [view] = await listMemoryProposalsFor('alice', 's1')
    expect(view.recorded).toEqual({ choice: 'save', flags: { i0: true, i1: false } })
  })
})

describe('review 1: erased or switched-off memory offers nothing', () => {
  // RV4. MUTATION: drop the switch read from the list → the text is shown after "Forget everything" → red.
  it('RV4 · with memory off the list is empty, whatever a row still holds', async () => {
    await propose()
    memoryOn = false
    expect(await listMemoryProposalsFor('alice', 's1')).toEqual([])
  })

  it('RV5 · and an answer after off-and-on-again cannot save a purged proposal', async () => {
    await propose()
    const id = requestId()
    held.delete(id) // the erase purged the row
    memoryOn = true
    expect(await answerMemoryProposalFor('alice', 's1', id, 'save')).toEqual({
      outcome: 'unavailable',
    })
    expect(memories()).toEqual([])
  })
})

describe('review 5: nothing to find costs no blob load', () => {
  // MUTATION: load the conversation first → red.
  it('a list with no row loads neither the switch nor the conversation', async () => {
    await propose()
    held.clear()
    loadConversation.mockClear()
    expect(await listMemoryProposalsFor('alice', 's1')).toEqual([])
    expect(loadConversation).not.toHaveBeenCalled()
  })
})

describe('review 7: the session cross-checks', () => {
  // MUTATION: drop `row.sessionId !== sessionId` → red.
  it('a row held under another conversation is unavailable, even for the same owner', async () => {
    await propose()
    const id = requestId()
    held.set(id, { ...held.get(id)!, sessionId: 's2' })
    expect(await answerMemoryProposalFor('alice', 's1', id, 'save')).toEqual({
      outcome: 'unavailable',
    })
    expect(memories()).toEqual([])
    expect(claims).toEqual([])
  })

  // MUTATION: drop `payload.conversationId !== sessionId` → red.
  it('a payload built for another conversation is unavailable', async () => {
    await propose()
    const id = requestId()
    const h = held.get(id)!
    held.set(id, { ...h, payload: { ...(h.payload as object), conversationId: 's2' } })
    expect(await answerMemoryProposalFor('alice', 's1', id, 'save')).toEqual({
      outcome: 'unavailable',
    })
    expect(memories()).toEqual([])
  })
})

describe('#579 review 2a: "nothing written" is the database\'s call', () => {
  const failing = async (id: string, setup: () => void, outcome: string) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      setup()
      expect((await answerMemoryProposalFor('alice', 's1', id, 'save')).outcome).toBe(outcome)
    } finally {
      warn.mockRestore()
    }
  }

  // D1. MUTATION: decide the release from this attempt's report (the old
  // `effects` heuristic), i.e. release unguarded → "Don't save" is recorded over
  // two written memories → red.
  it('D1 · save writes then the save is refused; a retry whose store fails does NOT release', async () => {
    await propose()
    const id = requestId()
    casOk = false
    expect((await answerMemoryProposalFor('alice', 's1', id, 'save')).outcome).toBe('conflict')
    casOk = true
    expect(memories()).toHaveLength(2)
    await failing(id, () => (storeFails = true), 'failed')
    storeFails = false
    expect(held.get(id)!.status).toBe('answering')
    expect(releases).toEqual([])
    expect(await answerMemoryProposalFor('alice', 's1', id, 'discard')).toEqual({
      outcome: 'already-answered',
    })
    expect(responses()).toEqual([])
    expect(memories()).toHaveLength(2)
  })

  // D2. MUTATION: release unconditionally on `report.skipped` → red.
  it('D2 · same, but the embedder changed between attempts: still bound', async () => {
    await propose()
    const id = requestId()
    casOk = false
    await answerMemoryProposalFor('alice', 's1', id, 'save')
    casOk = true
    await failing(id, () => (space = 'other/768'), 'unavailable')
    space = 'space/1024'
    expect(held.get(id)!.status).toBe('answering')
    expect(await answerMemoryProposalFor('alice', 's1', id, 'discard')).toEqual({
      outcome: 'already-answered',
    })
    expect(responses()).toEqual([])
  })

  it('D2b · and the switch turned off between attempts: still bound', async () => {
    await propose()
    const id = requestId()
    casOk = false
    await answerMemoryProposalFor('alice', 's1', id, 'save')
    casOk = true
    await failing(id, () => (memoryOn = false), 'memory-off')
    memoryOn = true
    expect(held.get(id)!.status).toBe('answering')
  })

  // D3. MUTATION: drop `inTransaction` from the store the answer builds → a
  // write proceeds under an answer that a concurrent attempt released → red.
  it('D3 · a release that lands before an item is written stops the write: nothing is stored', async () => {
    await propose()
    const id = requestId()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      releaseBeforeWrite = true
      expect((await answerMemoryProposalFor('alice', 's1', id, 'save')).outcome).toBe('failed')
    } finally {
      warn.mockRestore()
    }
    releaseBeforeWrite = false
    expect(memories()).toEqual([])
    expect(held.get(id)!.status).toBe('pending')
    expect(await answerMemoryProposalFor('alice', 's1', id, 'discard')).toEqual({
      outcome: 'discarded',
    })
  })

  // D4 (delta review 2). MUTATION: drop the `bound` argument / the answer
  // comparison in the binding check → the save writes under the discard binding
  // that claimed the row after a release → red.
  it('D4 · a release and a re-claim as "Don\'t save" between the claim and the first write: the save writes nothing', async () => {
    await propose()
    const id = requestId()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      reclaimAsDiscardBeforeWrite = true
      expect((await answerMemoryProposalFor('alice', 's1', id, 'save')).outcome).toBe('failed')
    } finally {
      reclaimAsDiscardBeforeWrite = false
      warn.mockRestore()
    }
    expect(memories()).toEqual([])
    expect(sources.size).toBe(0)
    // the row is still bound to discard, which is what the blob will record
    expect(held.get(id)!.status).toBe('answering')
    expect(held.get(id)!.answer).toEqual({ choice: 'discard', flags: {} })
    expect(await answerMemoryProposalFor('alice', 's1', id, 'discard')).toMatchObject({
      outcome: 'discarded',
    })
    expect(responses()).toEqual([expect.objectContaining({ choice: 'discard' })])
    expect(memories()).toEqual([])
  })
})

it('reads a legacy proposal tier canonically without rewriting the held payload', async () => {
  await propose()
  const id = requestId()
  const h = held.get(id)!
  const payload = h.payload as MemoryProposalPayload
  h.payload = { ...payload, tier: 'verda' }
  expect(await listMemoryProposalsFor('alice', 's1')).toHaveLength(1)
  await answerMemoryProposalFor('alice', 's1', id, 'save')
  expect(memories().length).toBeGreaterThan(0)
  expect(
    blob()
      .events.filter((e) => e.type === 'memory_written')
      .every((e) => (e.data as { tier: string }).tier === 'self_deployed'),
  ).toBe(true)
  expect((h.payload as MemoryProposalPayload).tier).toBe('verda')
})

it('refuses an unknown proposal tier before writing a memory', async () => {
  await propose()
  const id = requestId()
  const h = held.get(id)!
  h.payload = { ...(h.payload as MemoryProposalPayload), tier: 'unknown' }
  expect(await listMemoryProposalsFor('alice', 's1')).toHaveLength(0)
  expect(await answerMemoryProposalFor('alice', 's1', id, 'save')).toEqual({
    outcome: 'unavailable',
  })
  expect(memories()).toEqual([])
})
