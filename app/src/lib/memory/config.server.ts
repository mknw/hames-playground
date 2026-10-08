/** App policy for memory (#419 M5c). Constructing this bag performs no IO. */
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import type { ConfiguredPattern, MemoryConfig } from '@hames-ai/harness-patterns'
import { harnessUsesMemory } from '@hames-ai/harness-patterns/pattern-capabilities'
import {
  createDecideAdapter,
  createDecideAllAdapter,
} from '@hames-ai/harness-baml/baml-adapters.server'
import { createMemoryExtractAdapter } from '@hames-ai/harness-baml/baml-patterns.server'
import { limitsFor } from '@hames-ai/harness-baml/clients.server'
import { createMemoryDbStore } from '../db/memories.server'
import { getMemoryEnabled } from '../db/user-prefs.server'
import {
  getRequestUserId,
  getRequestMemoryWake,
  setRequestMemoryWake,
} from '../harness-client/request-user.server'
import {
  awaitMemoryWake,
  ensureMemoryAwake,
  memoryWakeTimeoutMs,
} from '../inference/memory-wake.server'
import { createMemoryEmbedder } from './embedder.server'

assertServerOnImport()

/** Fail closed for tiers the host does not recognise. */
export function visibleMemoryTiers(tier: string | undefined): readonly string[] {
  return tier === 'verda' ? ['anthropic', 'verda'] : tier === 'anthropic' ? ['anthropic'] : []
}

/** Every operation resolves the SAME supplier as core, even on a cached chain. */
export function createHostMemoryConfig(): MemoryConfig {
  const owner = getRequestUserId
  const store = () => {
    const id = owner()
    if (!id) throw new Error('Memory requires an owner')
    return createMemoryDbStore(id)
  }
  const decide = createDecideAdapter()
  return {
    owner,
    store: {
      count: (tiers) => store().count(tiers),
      candidates: (query) => store().candidates(query),
      transaction: (fn) => store().transaction(fn),
    },
    decide,
    decideAll: createDecideAllAdapter(decide),
    extract: createMemoryExtractAdapter(),
    embed: createMemoryEmbedder(),
    visibleTiers: visibleMemoryTiers,
    enabled: async () => {
      const id = owner()
      return id ? getMemoryEnabled(id) : false
    },
    awaitWake: waitForTurnMemoryWake,
    limits: () => limitsFor('compactExecution'),
    settle: { wakeBudgetMs: memoryWakeTimeoutMs() },
  }
}

/** Start before any pattern, then capture THIS poll while it is still current.
 * Later turns may start another poll; a late settle must retain this outcome. */
export function startTurnMemory<T>(
  patterns: ConfiguredPattern<T>[],
  memory?: MemoryConfig,
): MemoryConfig | undefined {
  if (!memory || !harnessUsesMemory(patterns)) return undefined
  void ensureMemoryAwake(true)
  setRequestMemoryWake(awaitMemoryWake(memoryWakeTimeoutMs()))
  return memory
}

/** Recall's shorter budget and settle's full budget share the captured poll. */
export async function waitForTurnMemoryWake(budgetMs: number): Promise<'awake' | 'skipped'> {
  const wake = getRequestMemoryWake()
  if (!wake) return 'skipped'
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      wake,
      new Promise<'skipped'>((resolve) => {
        timer = setTimeout(() => resolve('skipped'), budgetMs)
      }),
    ])
  } catch {
    return 'skipped'
  } finally {
    clearTimeout(timer)
  }
}
