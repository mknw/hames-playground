/**
 * estimateTurns — verifies each pattern factory's projection helper.
 *
 * Validates the primitive used by `harness()` to seed UI progress bars
 * before any pattern runs. Wrappers must delegate; loops must read settings.
 */

import { describe, it, expect, vi } from 'vitest'
import type { ConfiguredPattern } from '../../../lib/harness-patterns/types'

// Test-only relaxed cast — the wrappers accept patterns over different data
// shapes (RouterData, SimpleLoopData, etc.); compatibility isn't what we're
// testing here.
type AnyPattern = ConfiguredPattern<Record<string, unknown>>
const asAny = <T>(p: ConfiguredPattern<T>) => p as unknown as AnyPattern

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

// Stub out BAML-touching plumbing so these tests don't need the generated client.
vi.mock('@boundaryml/baml', () => ({
  Collector: class { constructor(_: unknown) {} },
  BamlValidationError: class extends Error {},
}))
vi.mock('../../../baml_client', () => ({ b: {} }))
vi.mock('../../../lib/harness-patterns/routing.server', () => ({
  routeMessageOp: vi.fn(),
}))

const settings = { maxToolTurns: 5, maxRetries: 3 }

describe('estimateTurns', () => {
  it('simpleLoop: uses config.maxTurns when present, else settings.maxToolTurns', async () => {
    const { simpleLoop } = await import('../../../lib/harness-patterns/patterns/simpleLoop.server')

    const fromSettings = simpleLoop(vi.fn(), [], { patternId: 'a' })
    expect(fromSettings.estimateTurns?.(settings)).toBe(5)

    const fromConfig = simpleLoop(vi.fn(), [], { patternId: 'b', maxTurns: 8 })
    expect(fromConfig.estimateTurns?.(settings)).toBe(8)
  })

  it('actorCritic: uses config.maxRetries when present, else settings.maxRetries', async () => {
    const { actorCritic } = await import('../../../lib/harness-patterns/patterns/actorCritic.server')

    const fromSettings = actorCritic(vi.fn(), vi.fn(), [], { patternId: 'a' })
    expect(fromSettings.estimateTurns?.(settings)).toBe(3)

    const fromConfig = actorCritic(vi.fn(), vi.fn(), [], { patternId: 'b', maxRetries: 7 })
    expect(fromConfig.estimateTurns?.(settings)).toBe(7)
  })

  it('router and synthesizer contribute 1', async () => {
    const { router } = await import('../../../lib/harness-patterns/patterns/router.server')
    const { synthesizer } = await import('../../../lib/harness-patterns/patterns/synthesizer.server')

    const r = router({ neo4j: 'db' })
    const s = synthesizer({ mode: 'thread' })
    expect(r.estimateTurns?.(settings)).toBe(1)
    expect(s.estimateTurns?.(settings)).toBe(1)
  })

  it('routes: max over branches', async () => {
    const { routes } = await import('../../../lib/harness-patterns/patterns/router.server')
    const { simpleLoop } = await import('../../../lib/harness-patterns/patterns/simpleLoop.server')

    const small = asAny(simpleLoop(vi.fn(), [], { patternId: 's', maxTurns: 2 }))
    const big = asAny(simpleLoop(vi.fn(), [], { patternId: 'b', maxTurns: 9 }))
    const dispatched = routes({ small, big })
    expect(dispatched.estimateTurns?.(settings)).toBe(9)
  })

  it('parallel: max over branches (longest drives perceived duration)', async () => {
    const { parallel } = await import('../../../lib/harness-patterns/patterns/parallel.server')
    const { simpleLoop } = await import('../../../lib/harness-patterns/patterns/simpleLoop.server')

    const a = asAny(simpleLoop(vi.fn(), [], { patternId: 'a', maxTurns: 4 }))
    const b = asAny(simpleLoop(vi.fn(), [], { patternId: 'b', maxTurns: 6 }))
    const par = parallel([a, b])
    expect(par.estimateTurns?.(settings)).toBe(6)
  })

  it('hook: 0 when background, delegates otherwise', async () => {
    const { hook } = await import('../../../lib/harness-patterns/patterns/hook.server')
    const { simpleLoop } = await import('../../../lib/harness-patterns/patterns/simpleLoop.server')

    const inner = asAny(simpleLoop(vi.fn(), [], { patternId: 'inner', maxTurns: 4 }))
    const bg = hook(inner, { trigger: 'session_close', background: true })
    const sync = hook(inner, { trigger: 'session_close' })
    expect(bg.estimateTurns?.(settings)).toBe(0)
    expect(sync.estimateTurns?.(settings)).toBe(4)
  })

  it('chain: sums children', async () => {
    const { chain } = await import('../../../lib/harness-patterns/patterns/chain.server')
    const { router, routes } = await import('../../../lib/harness-patterns/patterns/router.server')
    const { synthesizer } = await import('../../../lib/harness-patterns/patterns/synthesizer.server')
    const { simpleLoop } = await import('../../../lib/harness-patterns/patterns/simpleLoop.server')

    const loop = asAny(simpleLoop(vi.fn(), [], { patternId: 'loop', maxTurns: 5 }))
    // Default agent shape: router(1) + routes-with-5-turn-loop(5) + synth(1) = 7
    const agent = chain(asAny(router({ x: '' })), asAny(routes({ x: loop })), asAny(synthesizer({ mode: 'thread' })))
    expect(agent.estimateTurns?.(settings)).toBe(7)
  })
})
