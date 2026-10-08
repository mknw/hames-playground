import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createContext,
  createEvent,
  serializeContext,
  deserializeContext,
} from '@hames-ai/harness-patterns/context.server'
vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))
const sources = vi.hoisted(() =>
  vi.fn<
    (
      ...args: unknown[]
    ) => Promise<Array<{ eventId: string; ordinal: number; memoryId: string; tier: string }>>
  >(async () => []),
)
const read = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<{ kind: string; content: string } | null>>(async () => ({
    kind: 'preference',
    content: 'private text never copied',
  })),
)
const insert = vi.hoisted(() => vi.fn())
const addSource = vi.hoisted(() => vi.fn())
const available = vi.hoisted(() => vi.fn(() => true))
const transaction = vi.hoisted(() =>
  vi.fn(async (fn: (tx: object) => Promise<unknown>) => fn({ read, insert, addSource })),
)
const dbStore = vi.hoisted(() => vi.fn((_id: string) => ({ transaction })))
vi.mock('../../../lib/db/memories.server', () => ({
  isMemoryAvailable: available,
  listMemorySourcesForConversation: sources,
  createMemoryDbStore: dbStore,
}))
const { reconcileMemoryReferences } = await import('../../../lib/memory/reconcile.server')
const source = { eventId: 'ev-user', ordinal: 0, memoryId: 'mem-test', tier: 'verda' }
beforeEach(() => {
  vi.clearAllMocks()
  available.mockReturnValue(true)
  sources.mockResolvedValue([source])
  read.mockResolvedValue({ kind: 'preference', content: 'private text never copied' })
})
const blob = () => serializeContext(createContext('synthetic text', undefined, 'core-id'))

describe('one-directional reconciliation', () => {
  it('re-derives only missing source keys, with owner-scoped read and source tier', async () => {
    const repaired = await reconcileMemoryReferences(blob(), 'row-id', 'alice')
    expect(sources).toHaveBeenCalledWith('row-id', 'alice')
    expect(dbStore).toHaveBeenCalledWith('alice')
    expect(read).toHaveBeenCalledWith('mem-test')
    const events = deserializeContext(repaired).events.filter((e) => e.type === 'memory_written')
    expect(events).toHaveLength(1)
    expect(events[0].data).toEqual({
      memoryId: 'mem-test',
      kind: 'preference',
      tier: 'verda',
      eventId: 'ev-user',
      ordinal: 0,
      action: 'reinforced',
    })
    expect(repaired).not.toContain('private text')
    expect(await reconcileMemoryReferences(repaired, 'row-id', 'alice')).toBe(repaired)
    expect(read).toHaveBeenCalledTimes(1)
    expect(insert).not.toHaveBeenCalled()
    expect(addSource).not.toHaveBeenCalled()
  })
  it('null read means erased: no event, row or source, even after a source read raced deletion', async () => {
    read.mockResolvedValue(null)
    const original = blob()
    expect(await reconcileMemoryReferences(original, 'row-id', 'alice')).toBe(original)
    expect(insert).not.toHaveBeenCalled()
    expect(addSource).not.toHaveBeenCalled()
  })
  it('an erased memory still referenced in the blob creates no row, source or new event', async () => {
    const ctx = createContext('synthetic text')
    ctx.events.push(
      createEvent('memory_written', 'memory-store', {
        ...source,
        kind: 'preference',
        action: 'inserted',
      }),
    )
    sources.mockResolvedValue([])
    read.mockResolvedValue(null)
    const original = serializeContext(ctx)
    expect(await reconcileMemoryReferences(original, 'row-id', 'alice')).toBe(original)
    expect(read).not.toHaveBeenCalled()
    expect(transaction).not.toHaveBeenCalled()
    expect(insert).not.toHaveBeenCalled()
    expect(addSource).not.toHaveBeenCalled()
  })
  it('unavailable or refused reconciliation leaves the original blob and retries next load', async () => {
    const original = blob()
    available.mockReturnValue(false)
    expect(await reconcileMemoryReferences(original, 'row-id', 'alice')).toBe(original)
    expect(sources).not.toHaveBeenCalled()
    available.mockReturnValue(true)
    sources.mockRejectedValueOnce(new Error('outage'))
    expect(await reconcileMemoryReferences(original, 'row-id', 'alice')).toBe(original)
    expect(await reconcileMemoryReferences(original, 'row-id', 'alice')).not.toBe(original)
  })
})
