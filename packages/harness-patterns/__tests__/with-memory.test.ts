/**
 * #419 slice M5a — `withMemory`, and the `memory_context` threading through the
 * two patterns that author a user-visible answer. Every test names the source
 * mutation that reddens it; every one was run — see the PR's pin/mutation table.
 *
 *   with-memory-shape       — `[memoryRecall, ...patterns]`: recall FIRST, the
 *                             caller's patterns the SAME objects, and
 *                             `harnessUsesMemory` is what opts an agent in
 *   with-memory-one-switch  — recall and store read ONE `enabled`: the switch a
 *                             host supplies reaches both halves
 *   memory-context-compact  — `data.memoryContext` reaches `synthesize` as
 *                             `input.memoryContext`, and ONLY when recalled
 *   memory-context-router   — the router hands it to `route` as a fourth
 *                             argument, and ONLY when recalled
 */

import { describe, expect, it, vi } from 'vitest'
import {
  memoryStoreConfig,
  withMemory,
  type MemoryConfig,
} from '@hames-ai/harness-patterns/patterns/withMemory.server'
import { compactExecution } from '@hames-ai/harness-patterns/patterns/compactExecution.server'
import { router } from '@hames-ai/harness-patterns/patterns/router.server'
import { runChain } from '@hames-ai/harness-patterns/patterns/chain.server'
import { settleMemory } from '@hames-ai/harness-patterns/memory-store.server'
import { createContext } from '@hames-ai/harness-patterns/context.server'
import { harnessUsesMemory } from '@hames-ai/harness-patterns/pattern-capabilities'
import { withRunFrame } from '@hames-ai/harness-patterns/run-frame.server'
import type {
  CompactExecutionInput,
  ConfiguredPattern,
  DecideFn,
  DecideResult,
  MemoryCandidate,
  MemoryRecalledEventData,
  RouteExtra,
} from '@hames-ai/harness-patterns/types'

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

const SPACE = 'qwen3-embedding-0.6b/1024'
const BLOCK = '- [preference] prefers metric units'

type Data = Record<string, unknown>

const row: MemoryCandidate = {
  id: 'm1',
  kind: 'preference',
  tier: 'verda',
  content: 'prefers metric units',
  embedSpace: SPACE,
  distance: 0.1,
  lastSeenAt: Date.UTC(2026, 9, 1),
}

const decideAs = (probs: Record<string, number>) =>
  (async () =>
    ({ probs, method: 'logprob', calibrated: true }) as DecideResult) as unknown as DecideFn
const retrieves = decideAs({ retrieve: 0.9, skip: 0.1 })
const skips = decideAs({ retrieve: 0.1, skip: 0.9 })

function memoryConfig(over: Partial<MemoryConfig> = {}): MemoryConfig {
  return {
    store: {
      count: async () => 1,
      candidates: async () => [row],
      transaction: async () => {
        throw new Error('the store was not expected to write')
      },
    },
    decide: retrieves,
    extract: async () => ({ value: [] }),
    embed: {
      spaceId: SPACE,
      query: async () => [1, 0],
      documents: async (t: string[]) => t.map(() => [1, 0]),
    },
    owner: () => 'user-1',
    visibleTiers: () => ['verda', 'anthropic'],
    enabled: () => true,
    ...over,
  }
}

/** compactExecution with a spy for `synthesize`. */
function synth() {
  const inputs: CompactExecutionInput[] = []
  const pattern = compactExecution<Data>({
    mode: 'message',
    synthesize: async (input) => {
      inputs.push(input)
      return { value: 'ok' }
    },
  })
  return { inputs, pattern }
}

async function runWith(patterns: ConfiguredPattern<Data>[], input = 'what units do I prefer?') {
  const ctx = createContext<Data>(input)
  await withRunFrame({}, () => runChain(ctx, patterns))
  return ctx
}

const recalled = (ctx: { events: Array<{ type: string; data: unknown }> }) =>
  ctx.events
    .filter((e) => e.type === 'memory_recalled')
    .map((e) => e.data as MemoryRecalledEventData)

// ============================================================================
// with-memory-shape
// ============================================================================

describe('with-memory-shape', () => {
  it('prepends the recall step and returns the caller’s patterns as the SAME objects', () => {
    const a = synth().pattern
    const b = synth().pattern
    const out = withMemory<Data>(memoryConfig())([a, b])
    expect(out).toHaveLength(3)
    // Mutation: append (`[...patterns, recall]`) → out[0] is `a`.
    expect(out[0]).not.toBe(a)
    expect(out[0].capabilities?.memory).toBe(true)
    // Mutation: re-wrap / clone the patterns → identity fails.
    expect(out[1]).toBe(a)
    expect(out[2]).toBe(b)
  })

  it('is the opt-in: harnessUsesMemory is true with it and false without', () => {
    const bare = [synth().pattern]
    expect(harnessUsesMemory(bare)).toBe(false)
    // Mutation: return `patterns` unchanged → false here.
    expect(harnessUsesMemory(withMemory<Data>(memoryConfig())(bare))).toBe(true)
  })

  it('recall runs BEFORE the responder: the first turn already sees its block', async () => {
    const { inputs, pattern } = synth()
    const ctx = await runWith(withMemory<Data>(memoryConfig())([pattern]))
    expect(recalled(ctx)[0].attached).toEqual(['m1'])
    // Mutation: append instead of prepend → synthesize ran before recall wrote
    // `data.memoryContext`, so this is undefined.
    expect(inputs[0].memoryContext).toBe(BLOCK)
  })
})

// ============================================================================
// with-memory-one-switch
// ============================================================================

describe('with-memory-one-switch', () => {
  it('a switch that is OFF stops recall and the store; a switch that is ON stops neither', async () => {
    for (const on of [false, true]) {
      const cfg = memoryConfig({ enabled: () => on })
      const { inputs, pattern } = synth()
      const ctx = await runWith(withMemory<Data>(cfg)([pattern]))
      expect(recalled(ctx)[0].skipped).toBe(on ? undefined : 'disabled')
      expect(inputs[0].memoryContext).toBe(on ? BLOCK : undefined)

      // No run frame and no tier override: a switch that is ON gets past the
      // `disabled` stop and lands on the next one (`no-tier`), which is what
      // tells "the store read the switch" from "the store never got one".
      const report = await settleMemory(createContext('hi'), memoryStoreConfig(cfg))
      // Mutation (memoryStoreConfig drops `enabled`): on=true reports `disabled`.
      expect(report.skipped).toBe(on ? 'no-tier' : 'disabled')
    }
  })

  it('a switch that is OFF never reaches the store’s transaction', async () => {
    const transaction = vi.fn()
    const cfg = memoryConfig({
      enabled: () => false,
      store: { count: async () => 1, candidates: async () => [row], transaction },
    })
    await withRunFrame({ inference: { tier: 'verda' } }, () =>
      settleMemory(createContext('hi'), memoryStoreConfig(cfg)),
    )
    expect(transaction).not.toHaveBeenCalled()
  })
})

// ============================================================================
// memory-context-compact
// ============================================================================

describe('memory-context-compact', () => {
  it('carries the recalled block into the synthesis input', async () => {
    const { inputs, pattern } = synth()
    await runWith(withMemory<Data>(memoryConfig())([pattern]))
    // Mutation (compactExecution never copies `data.memoryContext`): undefined.
    expect(inputs[0].memoryContext).toBe(BLOCK)
  })

  it('has NO `memoryContext` key when nothing was recalled', async () => {
    const { inputs, pattern } = synth()
    await runWith(withMemory<Data>(memoryConfig({ decide: skips }))([pattern]))
    // Mutation (set it unconditionally, `''` or `undefined`): the key exists.
    expect('memoryContext' in inputs[0]).toBe(false)
  })

  it('never builds it from a block that is only whitespace', async () => {
    const { inputs, pattern } = synth()
    const ctx = createContext<Data>('hi', { memoryContext: '  \n ' })
    await withRunFrame({}, () => runChain(ctx, [pattern]))
    // Mutation (drop the `.trim()` test): the blank block is forwarded.
    expect('memoryContext' in inputs[0]).toBe(false)
  })
})

// ============================================================================
// memory-context-router
// ============================================================================

describe('memory-context-router', () => {
  const routeSpy = () => {
    const calls: unknown[][] = []
    const route = async (...args: unknown[]) => {
      calls.push(args)
      return {
        intent: 'units',
        tool_call_needed: false,
        tool_name: null,
        response_text: 'metric',
      }
    }
    return { calls, route: route as never }
  }

  it('hands the recalled block to `route` as the fourth argument', async () => {
    const { calls, route } = routeSpy()
    await runWith(
      withMemory<Data>(memoryConfig())([
        router<Data>({ neo4j: 'graph' }, { route }) as ConfiguredPattern<Data>,
      ]),
    )
    // Mutation (the router never reads `data.memoryContext`): length 3.
    expect(calls[0]).toHaveLength(4)
    expect(calls[0][3]).toEqual({ memoryContext: BLOCK } satisfies RouteExtra)
  })

  it('passes NO fourth argument when nothing was recalled', async () => {
    const { calls, route } = routeSpy()
    await runWith(
      withMemory<Data>(memoryConfig({ decide: skips }))([
        router<Data>({ neo4j: 'graph' }, { route }) as ConfiguredPattern<Data>,
      ]),
    )
    // Mutation (always pass `{ memoryContext }`, even empty): length 4.
    expect(calls[0]).toHaveLength(3)
  })

  it('a previous turn’s block never reaches a turn that recalled nothing', async () => {
    const { calls, route } = routeSpy()
    const patterns = [router<Data>({ neo4j: 'graph' }, { route }) as ConfiguredPattern<Data>]
    const ctx = createContext<Data>('what units do I prefer?')
    await withRunFrame({}, () => runChain(ctx, withMemory<Data>(memoryConfig())(patterns)))
    expect(calls[0][3]).toEqual({ memoryContext: BLOCK })
    // Turn 2, same `scope.data`, a gate that skips: recall clears the key, so
    // the router must not see turn 1's block.
    ctx.events.push(createContext('and for temperatures?').events[0])
    await withRunFrame({}, () =>
      runChain(ctx, withMemory<Data>(memoryConfig({ decide: skips }))(patterns)),
    )
    expect(calls[1]).toHaveLength(3)
  })
})
