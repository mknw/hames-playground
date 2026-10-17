/** Repair lost memory references on the next load (G9 Q2). Never replay a store. */
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import {
  createEvent,
  deserializeContext,
  serializeContext,
} from '@hames-ai/harness-patterns/context.server'
import type { MemoryWrittenEventData } from '@hames-ai/harness-patterns'
import {
  createMemoryDbStore,
  isMemoryAvailable,
  listMemorySourcesForConversation,
} from '../db/memories.server'

assertServerOnImport()

export async function reconcileMemoryReferences(
  serialized: string,
  conversationId: string,
  userId: string,
): Promise<string> {
  if (!isMemoryAvailable()) return serialized
  try {
    const ctx = deserializeContext(serialized)
    const recorded = new Set(
      ctx.events
        .filter((e) => e.type === 'memory_written')
        .map((e) => {
          const d = e.data as MemoryWrittenEventData
          return JSON.stringify([d.eventId, d.ordinal])
        }),
    )
    const sources = await listMemorySourcesForConversation(conversationId, userId)
    const missing = sources.filter((s) => !recorded.has(JSON.stringify([s.eventId, s.ordinal])))
    if (!missing.length) return serialized
    const events = await createMemoryDbStore(userId).transaction(async (tx) => {
      const derived = []
      for (const source of missing) {
        const memory = await tx.read(source.memoryId)
        // Erasure may have won after the source read. A null read is final.
        if (!memory) continue
        derived.push(
          createEvent('memory_written', 'memory-store', {
            memoryId: source.memoryId,
            kind: memory.kind,
            tier: source.tier,
            eventId: source.eventId,
            ordinal: source.ordinal,
            action: 'reinforced',
          } satisfies MemoryWrittenEventData),
        )
      }
      return derived
    })
    if (!events.length) return serialized
    ctx.events.push(...events)
    return serializeContext(ctx)
  } catch {
    console.warn('[memory] load reconciliation unavailable; retry on next load')
    return serialized
  }
}
