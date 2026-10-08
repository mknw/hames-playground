/**
 * Reviewer pin (PR #530): `withMemory`'s switch is REQUIRED at runtime, not only
 * in the type. A host that reaches it untyped (a JS caller, a spread of a
 * partial `AgentDeps.memory`, an `as never`) must fail closed at construction:
 * today recall treats an absent switch as ON and the store as OFF, the split
 * the combinator exists to prevent (D11).
 */
import { describe, expect, it } from 'vitest'
import {
  memoryStoreConfig,
  withMemory,
  type MemoryConfig,
} from '@hames-ai/harness-patterns/patterns/withMemory.server'
import type { DecideFn } from '@hames-ai/harness-patterns/types'

const base = {
  store: {
    count: async () => 0,
    candidates: async () => [],
    transaction: async () => {
      throw new Error('no writes')
    },
  },
  decide: (async () => ({})) as unknown as DecideFn,
  extract: async () => ({ value: [] }),
  embed: {
    spaceId: 's',
    query: async () => [1],
    documents: async (t: string[]) => t.map(() => [1]),
  },
  owner: () => 'user-1',
  visibleTiers: () => [],
}

describe('review-530: the switch is required at runtime', () => {
  it('withMemory and memoryStoreConfig refuse a config with no `enabled`', () => {
    const noSwitch = base as unknown as MemoryConfig
    // Mutation (drop the construction-time check): no throw.
    expect(() => withMemory(noSwitch)).toThrow(/enabled/)
    expect(() => memoryStoreConfig(noSwitch)).toThrow(/enabled/)
  })
})
