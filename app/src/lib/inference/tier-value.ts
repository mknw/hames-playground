/** Client-safe read compatibility. New writes use only the canonical union. */
import type { InferenceTier } from '@hames-ai/harness-baml/clients.server'

export function normalizeStoredInferenceTier(value: unknown): InferenceTier | null {
  if (value === 'verda' || value === 'self_deployed') return 'self_deployed'
  return value === 'anthropic' ? 'anthropic' : null
}

/** Project only typed metadata when reading a stored turn. Never rewrite text,
 * model records, arbitrary tool payloads or rows in the database.
 */
export function normalizeStoredContextTiers(serialized: string): string {
  const ctx = JSON.parse(serialized)
  if (!ctx || typeof ctx !== 'object') return serialized
  let changed = false
  const normalize = (record: { tier?: unknown }) => {
    if (record?.tier === 'verda') {
      record.tier = 'self_deployed'
      changed = true
    }
  }
  for (const event of Array.isArray(ctx.events) ? ctx.events : []) {
    if (['hitl_request', 'memory_recalled', 'memory_written'].includes(event?.type))
      normalize(event.data)
  }
  // Paused turns retain recalled memories; core strips them on completed turns.
  if (Array.isArray(ctx.data?.memories)) for (const memory of ctx.data.memories) normalize(memory)
  return changed ? JSON.stringify(ctx) : serialized
}
