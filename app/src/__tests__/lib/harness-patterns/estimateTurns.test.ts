/**
 * estimateTurns — verifies each pattern factory's projection helper.
 *
 * Validates the primitive used by `harness()` to seed UI progress bars
 * before any pattern runs. Wrappers must delegate; loops must read settings.
 */

import { describe, it, expect, vi } from 'vitest'
import type { ConfiguredPattern, ControllerFn } from '@hames/harness-patterns/types'

// Lane A5: ControllerFn is now an object-callable (optional limits()). A bare
// vi.fn() placeholder doesn't satisfy it, so these never-called stubs cast.
const stubController = () => vi.fn() as unknown as ControllerFn

// Test-only relaxed cast — the wrappers accept patterns over different data
// shapes (RouterData, SimpleLoopData, etc.); compatibility isn't what we're
// testing here.
type AnyPattern = ConfiguredPattern<Record<string, unknown>>
const asAny = <T>(p: ConfiguredPattern<T>) => p as unknown as AnyPattern

vi.mock('@hames/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

// Stub out BAML-touching plumbing so these tests don't need the generated client.
vi.mock('@boundaryml/baml', () => ({
  Collector: class {
    constructor(_: unknown) {}
  },
  BamlValidationError: class extends Error {},
}))
vi.mock('@hames/harness-baml/baml_client', () => ({ b: {} }))

// Construction-only assertions: the REQUIRED injected implementations
// (`route`, `synthesize` — BAML-companion seam lane) are stubs; the pattern
// bodies never run here.
const stubRoute = vi.fn()
const stubSynthesize = vi.fn(async () => ({ value: '' }))

const settings = { maxToolTurns: 5, maxRetries: 3 }

describe('estimateTurns', () => {
  it('simpleLoop: uses config.maxTurns when present, else settings.maxToolTurns', async () => {
    const { simpleLoop } = await import('@hames/harness-patterns/patterns/simpleLoop.server')

    const fromSettings = simpleLoop(stubController(), [], { patternId: 'a' })
    expect(fromSettings.estimateTurns?.(settings)).toBe(5)

    const fromConfig = simpleLoop(stubController(), [], { patternId: 'b', maxTurns: 8 })
    expect(fromConfig.estimateTurns?.(settings)).toBe(8)
  })

  it('actorCritic: uses config.maxRetries when present, else settings.maxRetries', async () => {
    const { actorCritic } = await import('@hames/harness-patterns/patterns/actorCritic.server')

    const fromSettings = actorCritic(vi.fn(), vi.fn(), [], { patternId: 'a' })
    expect(fromSettings.estimateTurns?.(settings)).toBe(3)

    const fromConfig = actorCritic(vi.fn(), vi.fn(), [], { patternId: 'b', maxRetries: 7 })
    expect(fromConfig.estimateTurns?.(settings)).toBe(7)
  })

  it('router and compactExecution contribute 1', async () => {
    const { router } = await import('@hames/harness-patterns/patterns/router.server')
    const { compactExecution } =
      await import('@hames/harness-patterns/patterns/compactExecution.server')

    const r = router({ neo4j: 'db' }, { route: stubRoute })
    const s = compactExecution({ mode: 'thread', synthesize: stubSynthesize })
    expect(r.estimateTurns?.(settings)).toBe(1)
    expect(s.estimateTurns?.(settings)).toBe(1)
  })

  it('planner contributes 1 (one call per chain invocation, never a loop)', async () => {
    const { planner } = await import('@hames/harness-patterns/patterns/planner.server')

    // Lane A6: the plan fn is REQUIRED config; estimateTurns is static, so a
    // never-called stub stands in for it.
    expect(planner(vi.fn(), [], { patternId: 'plan' }).estimateTurns?.(settings)).toBe(1)
  })

  it('routes: max over branches', async () => {
    const { routes } = await import('@hames/harness-patterns/patterns/router.server')
    const { simpleLoop } = await import('@hames/harness-patterns/patterns/simpleLoop.server')

    const small = asAny(simpleLoop(stubController(), [], { patternId: 's', maxTurns: 2 }))
    const big = asAny(simpleLoop(stubController(), [], { patternId: 'b', maxTurns: 9 }))
    const dispatched = routes({ small, big })
    expect(dispatched.estimateTurns?.(settings)).toBe(9)
  })

  it('parallel: max over branches (longest drives perceived duration)', async () => {
    const { parallel } = await import('@hames/harness-patterns/patterns/parallel.server')
    const { simpleLoop } = await import('@hames/harness-patterns/patterns/simpleLoop.server')

    const a = asAny(simpleLoop(stubController(), [], { patternId: 'a', maxTurns: 4 }))
    const b = asAny(simpleLoop(stubController(), [], { patternId: 'b', maxTurns: 6 }))
    const par = parallel([a, b])
    expect(par.estimateTurns?.(settings)).toBe(6)
  })

  it('chain: sums children', async () => {
    const { chain } = await import('@hames/harness-patterns/patterns/chain.server')
    const { router, routes } = await import('@hames/harness-patterns/patterns/router.server')
    const { compactExecution } =
      await import('@hames/harness-patterns/patterns/compactExecution.server')
    const { simpleLoop } = await import('@hames/harness-patterns/patterns/simpleLoop.server')

    const loop = asAny(simpleLoop(stubController(), [], { patternId: 'loop', maxTurns: 5 }))
    // Default agent shape: router(1) + routes-with-5-turn-loop(5) + synth(1) = 7
    const agent = chain(
      asAny(router({ x: '' }, { route: stubRoute })),
      asAny(routes({ x: loop })),
      asAny(compactExecution({ mode: 'thread', synthesize: stubSynthesize })),
    )
    expect(agent.estimateTurns?.(settings)).toBe(7)
  })
})
