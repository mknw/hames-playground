/**
 * Reviewer pins (PR #530): `MemoryConfig` carries no `tier`. At e6543b19 its one
 * `tier` reached both halves and only the store refused one that disagreed with
 * the run frame, so recall read private-tier rows into a public-tier turn.
 * D8 / SD-12: a private-tier memory is never recalled into a public-tier turn.
 */
import { describe, expect, it } from 'vitest'
import {
  withMemory,
  type MemoryConfig,
} from '@hames-ai/harness-patterns/patterns/withMemory.server'
import { compactExecution } from '@hames-ai/harness-patterns/patterns/compactExecution.server'
import { runChain } from '@hames-ai/harness-patterns/patterns/chain.server'
import { settleMemory } from '@hames-ai/harness-patterns/memory-store.server'
import { memoryStoreConfig } from '@hames-ai/harness-patterns/patterns/withMemory.server'
import { createContext } from '@hames-ai/harness-patterns/context.server'
import { withRunFrame } from '@hames-ai/harness-patterns/run-frame.server'
import type {
  CompactExecutionInput,
  DecideFn,
  DecideResult,
  MemoryCandidate,
} from '@hames-ai/harness-patterns/types'

type Data = Record<string, unknown>
const SPACE = 's'
const privateRow: MemoryCandidate = {
  id: 'm-verda',
  kind: 'preference',
  tier: 'verda',
  content: 'prefers metric units',
  embedSpace: SPACE,
  distance: 0.1,
  lastSeenAt: Date.UTC(2026, 9, 1),
}
const retrieves = (async () =>
  ({
    probs: { retrieve: 0.9, skip: 0.1 },
    method: 'logprob',
    calibrated: true,
  }) as DecideResult) as unknown as DecideFn

// The tier rule exactly as #419 states it: anthropic sees anthropic, verda sees both.
const visibleTiers = (t: string | undefined) =>
  t === 'verda' ? ['verda', 'anthropic'] : t === 'anthropic' ? ['anthropic'] : []

function cfg(over: Partial<MemoryConfig> = {}): MemoryConfig {
  return {
    store: {
      count: async () => 1,
      // An honest store: it returns only rows of the tiers asked for.
      candidates: async ({ tiers }) => (tiers.includes('verda') ? [privateRow] : []),
      transaction: async () => {
        throw new Error('no writes expected')
      },
    },
    decide: retrieves,
    extract: async () => ({ value: [] }),
    embed: {
      spaceId: SPACE,
      query: async () => [1, 0],
      documents: async (t) => t.map(() => [1, 0]),
    },
    owner: () => 'user-1',
    visibleTiers,
    enabled: () => true,
    ...over,
  }
}

describe('review-530: a tier override that disagrees with the run frame', () => {
  it('recall never puts a verda memory into an anthropic-tier turn', async () => {
    const inputs: CompactExecutionInput[] = []
    const responder = compactExecution<Data>({
      mode: 'message',
      synthesize: async (i) => {
        inputs.push(i)
        return { value: 'ok' }
      },
    })
    const c = cfg({ tier: () => 'verda' } as unknown as Partial<MemoryConfig>)
    const ctx = createContext<Data>('what units do I prefer?')
    await withRunFrame({ inference: { tier: 'anthropic' } }, () =>
      runChain(ctx, withMemory<Data>(c)([responder])),
    )
    // The responder's calls run on the FRAME's tier (anthropic, a public
    // provider). The private memory must not be in its input. RED at e6543b19;
    // mutation (withMemory forwards `cfg.tier` to memoryRecall again): RED.
    expect(inputs[0].memoryContext ?? '').not.toContain('metric')
  })

  it('the store half carries no tier of its own either: the frame is the one truth', () => {
    const c = cfg({ tier: () => 'verda' } as unknown as Partial<MemoryConfig>)
    // Mutation (memoryStoreConfig forwards `cfg.tier` again): the key is back.
    expect('tier' in memoryStoreConfig(c)).toBe(false)
  })
})
