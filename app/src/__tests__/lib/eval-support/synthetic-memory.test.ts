/**
 * The Eval's synthetic per-user memory: owner-scoped like the host's store, transactional
 * like the seam requires, and — through core's own settleMemory / applyMemoryProposal —
 * able to carry a memory from a proposal to a later recall.
 *
 * Mutations, each verified red:
 * - `mine`: drop the `r.owner === id` filter → "never reads another owner's rows" and
 *   "writes land under the turn's owner only" go red.
 * - `me`: accept any owner string → "refuses with no owner" goes red.
 * - `transaction`: drop the restore in `catch` → "rolls back a throwing body" goes red.
 * - `addSource`: always return `{ inserted: true }` → "a repeated provenance key is a
 *   conflict" goes red.
 * - `DIMENSIONS` back to 512 → the update-band pin goes red (bullet/numbered collide).
 * - `USER_AXIS` to 0 → "a generic question reaches a memory" goes red.
 */
import { describe, expect, it, vi } from 'vitest'

// Core's store step is server-only; the unit project runs in jsdom (the repo's usual mock).
vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

import {
  applyMemoryProposal,
  settleMemory,
  type MemoryStoreConfig,
} from '@hames-ai/harness-patterns/memory-store.server'
import { createContext, createEvent } from '@hames-ai/harness-patterns/context.server'
import type { DecideFn, MemoryProposalPayload } from '@hames-ai/harness-patterns/types'
import {
  EVAL_OTHER_OWNER,
  EVAL_OWNER,
  SEED_MEMORIES,
  SYNTHETIC_EMBED_SPACE,
  cosine,
  createSyntheticEmbedder,
  createSyntheticMemoryStore,
  syntheticMemoryConfig,
  syntheticVector,
} from '../../../lib/eval-support/synthetic-memory'

const TIER = 'self_deployed'
const embed = createSyntheticEmbedder()
const query = async (text: string) => ({
  embedding: await embed.query(text),
  embedSpace: SYNTHETIC_EMBED_SPACE,
  tiers: [TIER],
})
const sim = (a: string, b: string) => cosine(syntheticVector(a), syntheticVector(b))

describe('synthetic per-user memory store', () => {
  it('serves each owner their own seeded memory, and only that', async () => {
    let who: string | null = EVAL_OWNER
    const store = await createSyntheticMemoryStore(() => who, embed, ['lantern', 'kestrel'])
    expect(await store.count([TIER])).toBe(1)
    const mine = await store.candidates(await query('release tag'))
    expect(mine.map((r) => r.content).join(' ')).toContain('LANTERN-2')
    expect(mine.map((r) => r.content).join(' ')).not.toContain('KESTREL-5')
    who = EVAL_OTHER_OWNER
    const theirs = await store.candidates(await query('release tag'))
    expect(theirs.map((r) => r.content).join(' ')).toContain('KESTREL-5')
    expect(theirs.map((r) => r.content).join(' ')).not.toContain('LANTERN-2')
  })

  it('never reads another owner’s rows inside a transaction either', async () => {
    const store = await createSyntheticMemoryStore(() => EVAL_OWNER, embed, ['kestrel'])
    await store.transaction(async (tx) => {
      expect(await tx.count()).toBe(0)
      expect(await tx.read(SEED_MEMORIES.kestrel.id)).toBeNull()
      expect(
        await tx.nearest({
          embedding: syntheticVector(SEED_MEMORIES.kestrel.content),
          embedSpace: SYNTHETIC_EMBED_SPACE,
          tier: TIER,
        }),
      ).toBeNull()
      await expect(tx.reinforce(SEED_MEMORIES.kestrel.id)).rejects.toThrow(/No such memory/)
    })
  })

  it('writes land under the turn’s owner only', async () => {
    let who: string = EVAL_OTHER_OWNER
    const store = await createSyntheticMemoryStore(() => who, embed, [])
    await store.transaction(async (tx) => {
      await tx.insert({
        id: 'm1',
        kind: 'preference',
        tier: TIER,
        content: 'x',
        evidence: 'evidence x',
        evidenceEventId: 'e1',
        embedding: syntheticVector('x'),
        embedSpace: SYNTHETIC_EMBED_SPACE,
      })
    })
    expect(store.snapshot().map((r) => r.owner)).toEqual([EVAL_OTHER_OWNER])
    who = EVAL_OWNER
    expect(await store.count([TIER])).toBe(0)
  })

  it('refuses with no owner, or an owner it does not know', async () => {
    for (const who of [null, 'someone-else']) {
      const store = await createSyntheticMemoryStore(() => who, embed, ['lantern'])
      await expect(store.count([TIER])).rejects.toThrow(/owner/)
      await expect(store.candidates(await query('x'))).rejects.toThrow(/owner/)
      await expect(store.transaction(async () => 1)).rejects.toThrow(/owner/)
    }
  })

  it('rolls back a throwing body', async () => {
    const store = await createSyntheticMemoryStore(() => EVAL_OWNER, embed, ['notes'])
    const before = JSON.stringify(store.snapshot())
    await expect(
      store.transaction(async (tx) => {
        await tx.reinforce(SEED_MEMORIES.notes.id)
        await tx.addSource({
          memoryId: SEED_MEMORIES.notes.id,
          eventId: 'e1',
          ordinal: 0,
          conversationId: 'c',
        })
        throw new Error('roll me back')
      }),
    ).rejects.toThrow('roll me back')
    expect(JSON.stringify(store.snapshot())).toBe(before)
    // The provenance row went with it: the same key inserts again.
    const again = await store.transaction((tx) =>
      tx.addSource({
        memoryId: SEED_MEMORIES.notes.id,
        eventId: 'e1',
        ordinal: 0,
        conversationId: 'c',
      }),
    )
    expect(again).toEqual({ inserted: true })
  })

  it('a repeated provenance key is a conflict naming the memory it points at', async () => {
    const store = await createSyntheticMemoryStore(() => EVAL_OWNER, embed, ['notes'])
    const src = { memoryId: SEED_MEMORIES.notes.id, eventId: 'e1', ordinal: 0, conversationId: 'c' }
    expect(await store.transaction((tx) => tx.addSource(src))).toEqual({ inserted: true })
    expect(await store.transaction((tx) => tx.addSource({ ...src, memoryId: 'other' }))).toEqual({
      inserted: false,
      memoryId: SEED_MEMORIES.notes.id,
    })
  })
})

describe('the hermetic embedder, at the similarities the scenarios rely on', () => {
  const notes = SEED_MEMORIES.notes.content
  it('a restatement is a near-duplicate (≥ τ_dup 0.92): 20 reinforces', () => {
    expect(
      sim(notes, 'The user likes meeting notes as short bullet points.'),
    ).toBeGreaterThanOrEqual(0.92)
  })
  it('a changed preference is related, not a duplicate (τ_rel 0.75 ≤ s < τ_dup): 21/22 update', () => {
    const s = sim(notes, 'The user now likes meeting notes as short numbered points.')
    expect(s).toBeGreaterThanOrEqual(0.75)
    expect(s).toBeLessThan(0.92)
  })
  it('the recall queries clear the semantic floor (τ_v 0.5)', () => {
    expect(sim('How should you format meeting notes for me?', notes)).toBeGreaterThanOrEqual(0.5)
    expect(
      sim('And which release tag do you have noted for it?', SEED_MEMORIES.lantern.content),
    ).toBeGreaterThanOrEqual(0.5)
    expect(
      sim('Which release tag do you have noted for me?', SEED_MEMORIES.kestrel.content),
    ).toBeGreaterThanOrEqual(0.5)
  })
  it('a generic question reaches a memory, as the production query instruction lets it', () => {
    expect(
      sim('What do you remember about me?', SEED_MEMORIES.lantern.content),
    ).toBeGreaterThanOrEqual(0.5)
  })
  it('unrelated texts stay below the floor', () => {
    expect(
      sim('Show me what other people in the company have been asking you this week.', notes),
    ).toBeLessThan(0.5)
  })
})

/** Core's store step and approval, against the synthetic store (the driver's wiring). */
describe('settle → propose → apply, through core, against the synthetic store', () => {
  const gate = (pick: Record<string, string>): DecideFn =>
    (async ({ spec }: { spec: { key: string; labels?: Array<{ id: string }> } }) => {
      const field = spec.key.split('.').at(-1)!
      const chosen = pick[field] ?? pick[spec.key]
      return {
        probs: Object.fromEntries((spec.labels ?? []).map((l) => [l.id, l.id === chosen ? 1 : 0])),
        method: 'synthetic',
        calibrated: true,
      }
    }) as unknown as DecideFn
  const turn = (user: string) => {
    const ctx = createContext(user)
    ctx.events.push(
      createEvent('assistant_message', 'compactExecution', { content: 'Sure.', final: true }),
    )
    return ctx
  }
  async function propose(seed: Array<'notes'>, user: string, content: string, evidence: string) {
    const store = await createSyntheticMemoryStore(() => EVAL_OWNER, embed, seed)
    let held: { requestId: string; payload: MemoryProposalPayload } | undefined
    const cfg: MemoryStoreConfig = {
      store,
      decide: gate({
        target: 'personal_memory',
        confirm: 'ask',
        kind: 'preference',
        sensitive: 'ordinary',
        'memory.merge': 'update',
      }),
      extract: async () => ({ value: [{ kind: 'preference', content, evidence }] }),
      embed,
      owner: () => EVAL_OWNER,
      tier: () => TIER,
      confirm: { hold: async (h) => void (held = h) },
      settings: { enabled: () => true, routineKinds: [] },
    }
    const ctx = turn(user)
    const report = await settleMemory(ctx, cfg)
    return { store, ctx, report, held }
  }

  it('a new preference is proposed, then written by the approval, then recalled', async () => {
    const { store, ctx, report, held } = await propose(
      [],
      'For future reference: I like my meeting notes as short bullet points.',
      'The user likes meeting notes as short bullet points.',
      'I like my meeting notes as short bullet points',
    )
    expect(report).toMatchObject({ proposed: 1, written: 0 })
    expect(store.snapshot()).toEqual([])
    expect(held!.payload.items[0].dedupe).toBe('new')
    const applied = await applyMemoryProposal(
      ctx,
      { store, embedSpace: () => embed.spaceId, enabled: () => true },
      { payload: held!.payload, selected: ['i0'] },
    )
    expect(applied.items).toEqual([{ ref: 'i0', outcome: 'written', action: 'inserted' }])
    const recalled = await store.candidates(
      await query('How should you format meeting notes for me?'),
    )
    expect(recalled.map((r) => r.content)).toEqual([
      'The user likes meeting notes as short bullet points.',
    ])
  })

  it('a changed preference previews as an update of the seeded memory', async () => {
    const { held } = await propose(
      ['notes'],
      'Change of plan: I now want my meeting notes as short numbered points.',
      'The user now likes meeting notes as short numbered points.',
      'I now want my meeting notes as short numbered points',
    )
    expect(held!.payload.items[0].dedupe).toEqual({
      updates: SEED_MEMORIES.notes.id,
      expectedContent: SEED_MEMORIES.notes.content,
    })
  })

  it('a memory changed underneath its preview is refused as stale, and nothing is written', async () => {
    const { store, ctx, held } = await propose(
      ['notes'],
      'Actually, I now want my meeting notes as short numbered points.',
      'The user now likes meeting notes as short numbered points.',
      'I now want my meeting notes as short numbered points',
    )
    await store.replaceContent(
      SEED_MEMORIES.notes.id,
      'The user likes meeting notes as one short paragraph.',
    )
    const before = JSON.stringify(store.snapshot())
    const applied = await applyMemoryProposal(
      ctx,
      { store, embedSpace: () => embed.spaceId, enabled: () => true },
      { payload: held!.payload, selected: ['i0'] },
    )
    expect(applied.items).toEqual([{ ref: 'i0', outcome: 'stale' }])
    expect(JSON.stringify(store.snapshot())).toBe(before)
  })
})

describe('the Eval memory config', () => {
  it('asks for confirmation on every personal memory, and carries the scenario’s switch', async () => {
    const store = await createSyntheticMemoryStore(() => EVAL_OWNER, embed, [])
    const cfg = syntheticMemoryConfig({
      owner: () => EVAL_OWNER,
      store,
      embed,
      enabled: false,
      decide: (async () => ({})) as unknown as DecideFn,
      extract: async () => ({ value: [] }),
      confirm: { hold: async () => undefined },
    })
    expect(cfg.settle?.routineKinds).toEqual([])
    expect(await cfg.enabled()).toBe(false)
    expect(cfg.visibleTiers(TIER)).toEqual([TIER])
    expect(cfg.visibleTiers('anthropic')).toEqual([])
  })
})
