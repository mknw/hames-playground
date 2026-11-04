/**
 * Link the memories an approval just wrote to the graph nodes they are about
 * (org-knowledge slice 8, LD-15). Server only; not a `'use server'` module.
 *
 * Deterministic and best-effort: no model is consulted, and a graph or write
 * failure links nothing and never fails the approval — a memory without links
 * is exactly the memory the person saved. Only an `inserted` or `updated`
 * memory is (re)linked, from the evidence the proposal carried; a `reinforced`
 * one keeps what it had.
 */
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import type {
  ContextEvent,
  MemoryProposalPayload,
  MemoryWrittenEventData,
} from '@hames-ai/harness-patterns'
import { replaceMemoryGraphLinks } from '../db/memories.server'
import { findLinkableNodes } from '../org-graph/memory-links.server'

assertServerOnImport()

export interface GraphLinkSeams {
  readonly find: (text: string) => Promise<readonly string[]>
  readonly replace: (userId: string, memoryId: string, nodeIds: readonly string[]) => Promise<void>
}

const DEFAULT_SEAMS: GraphLinkSeams = { find: findLinkableNodes, replace: replaceMemoryGraphLinks }

/** Link every memory a `memory_written` event among `written` names as
 *  inserted or updated. Returns how many memories got at least one link. */
export async function linkWrittenMemories(
  userId: string,
  payload: MemoryProposalPayload,
  written: readonly ContextEvent[],
  seams: GraphLinkSeams = DEFAULT_SEAMS,
): Promise<number> {
  let linked = 0
  for (const event of written) {
    if (event.type !== 'memory_written') continue
    const data = event.data as MemoryWrittenEventData
    if (data.action === 'reinforced' || data.eventId !== payload.eventId) continue
    const item = payload.items.find((i) => i.ordinal === data.ordinal)
    if (!item) continue
    try {
      const nodes = await seams.find(item.evidence)
      await seams.replace(userId, data.memoryId, nodes)
      if (nodes.length > 0) linked += 1
    } catch (err) {
      console.warn(
        '[memory] graph links not written for one memory:',
        err instanceof Error && err.name ? err.name : 'Error',
      )
    }
  }
  return linked
}
