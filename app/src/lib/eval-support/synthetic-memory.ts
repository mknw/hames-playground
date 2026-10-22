/**
 * Synthetic per-user memory for the general-next Eval: the same `MemoryConfig` seam the host
 * binds to its encrypted per-user store, backed by two owners' rows held in memory. Every
 * method resolves the owner on EACH call and reads only that owner's rows, so a recall that
 * could reach another user's memory would show up here as that user's content. Read-only: the
 * store step (settleMemory) is host-side and the Eval never runs it.
 */
import type { MemoryConfig } from '@hames-ai/harness-patterns'
import type { DecideFn, MemoryCandidate, MemoryKind } from '@hames-ai/harness-patterns/types'

export const EVAL_OWNER = 'eval-user'
export const EVAL_OTHER_OWNER = 'eval-other-user'
const TIER = 'self_deployed'
const SPACE = 'eval-synthetic/2'

interface Row {
  readonly owner: string
  readonly id: string
  readonly kind: MemoryKind
  readonly content: string
}

/** What each owner confirmed in earlier conversations. Synthetic. */
export const SYNTHETIC_MEMORIES: readonly Row[] = [
  {
    owner: EVAL_OWNER,
    id: 'mem-own-1',
    kind: 'semantic',
    content: 'Works on the Lantern project; its release tag is LANTERN-2.',
  },
  {
    owner: EVAL_OTHER_OWNER,
    id: 'mem-other-1',
    kind: 'semantic',
    content: 'Works on the Kestrel project; its release tag is KESTREL-5.',
  },
]

export function createSyntheticMemory(owner: () => string | null): MemoryConfig {
  const mine = (): Row[] => {
    const id = owner()
    if (!id) throw new Error('Memory requires an owner')
    return SYNTHETIC_MEMORIES.filter((r) => r.owner === id)
  }
  const retrieve = (async () => ({
    probs: { retrieve: 0.9, skip: 0.1 },
    method: 'synthetic',
    calibrated: true,
  })) as unknown as DecideFn
  return {
    owner,
    store: {
      count: async () => mine().length,
      candidates: async (): Promise<MemoryCandidate[]> =>
        mine().map((r) => ({
          id: r.id,
          kind: r.kind,
          tier: TIER,
          content: r.content,
          embedSpace: SPACE,
          distance: 0.1,
          lastSeenAt: Date.UTC(2026, 9, 1),
        })),
      transaction: async () => {
        throw new Error('The Eval memory is read-only')
      },
    },
    decide: retrieve,
    extract: async () => ({ value: [] }),
    embed: {
      spaceId: SPACE,
      query: async () => [1, 0],
      documents: async (texts: string[]) => texts.map(() => [1, 0]),
    },
    visibleTiers: () => [TIER],
    enabled: () => true,
  }
}
