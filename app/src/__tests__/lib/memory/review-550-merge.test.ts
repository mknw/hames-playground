// Review 550 R1: a load that repairs references while the settling turn's
// trailing save is still pending must not leave TWO memory_written events for
// one (eventId, ordinal) once that save merges onto the repaired row.
import { describe, it, expect, vi } from 'vitest'
import {
  createContext,
  createEvent,
  serializeContext,
  deserializeContext,
} from '@hames-ai/harness-patterns/context.server'
import type { MemoryWrittenEventData, UnifiedContext } from '@hames-ai/harness-patterns'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))
vi.mock('../../../lib/db/memories.server', () => ({
  isMemoryAvailable: () => true,
  // The settle committed this candidate's source; its event is not saved yet.
  listMemorySourcesForConversation: async () => [
    { eventId: 'ev-user', ordinal: 0, memoryId: 'mem-1', tier: 'anthropic' },
  ],
  createMemoryDbStore: () => ({
    transaction: async (fn: (tx: object) => Promise<unknown>) =>
      fn({ read: async () => ({ kind: 'preference', content: 'synthetic' }) }),
  }),
}))
const { reconcileMemoryReferences } = await import('../../../lib/memory/reconcile.server')
const { mergeTrailingPass } = await import('../../../lib/harness-client/turn.server')

const key = (ctx: UnifiedContext) =>
  ctx.events
    .filter((e) => e.type === 'memory_written')
    .map((e) => e.data as MemoryWrittenEventData)
    .filter((d) => d.eventId === 'ev-user' && d.ordinal === 0)

describe('review 550 R1: repair on load + trailing merge', () => {
  it('keeps exactly one memory_written per source key, and it is the settle’s own record', async () => {
    const saved = createContext('synthetic question', undefined, 'sess')
    saved.events[0].id = 'ev-user'
    saved.events.push(createEvent('assistant_message', 'answer', { content: 'ok', final: true }))
    const savedCount = saved.events.length
    // What the settle appended in memory, after the main save.
    const ours = deserializeContext(serializeContext(saved))
    ours.events.push(
      createEvent('memory_written', 'memory-store', {
        memoryId: 'mem-1',
        kind: 'preference',
        tier: 'anthropic',
        eventId: 'ev-user',
        ordinal: 0,
        action: 'inserted',
      } satisfies MemoryWrittenEventData),
    )
    // A load (page open, hasPendingApproval, the next turn's claim) repaired the
    // row first — so the trailing save's first attempt misses and it merges.
    // A second candidate of the same turn, committed after the load read.
    ours.events.push(
      createEvent('memory_written', 'memory-store', {
        memoryId: 'mem-2',
        kind: 'episodic',
        tier: 'anthropic',
        eventId: 'ev-user',
        ordinal: 1,
        action: 'inserted',
      } satisfies MemoryWrittenEventData),
    )
    const fresh = deserializeContext(
      await reconcileMemoryReferences(serializeContext(saved), 'sess', 'owner'),
    )
    expect(key(fresh)).toHaveLength(1)
    const merged = mergeTrailingPass(fresh, ours, savedCount)
    expect(key(merged)).toEqual([expect.objectContaining({ action: 'inserted' })])
    expect(
      merged.events
        .filter((e) => e.type === 'memory_written')
        .map((e) => (e.data as MemoryWrittenEventData).memoryId),
    ).toEqual(['mem-1', 'mem-2'])
  })
})
