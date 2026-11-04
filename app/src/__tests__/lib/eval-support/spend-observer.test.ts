import { describe, it, expect, vi } from 'vitest'
import { SpendBudget, type SpendKey } from '../../../lib/eval-support/spend-budget'
import { createSpendObserver } from '../../../lib/eval-support/spend-observer'
import { PRIVATE_TIER_CLIENTS } from '@hames-ai/harness-baml/clients.server'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))
const key: SpendKey = { agent: 'general-next', scenario: 'test', tier: 'self_deployed' }
const setup = (live = true) => {
  const budget = new SpendBudget(20, 0.8)
  const onStop = vi.fn()
  return {
    budget,
    onStop,
    observer: createSpendObserver({ budget, live, onStop, privateClients: PRIVATE_TIER_CLIENTS }),
  }
}
describe('runner synchronous spend stop', () => {
  it.each(['Anthropic', undefined])(
    'stops an unexpected or absent serving client %s',
    (clientName) => {
      const { budget, observer, onStop } = setup()
      observer.activate(key)
      observer.observe({ clientName, metrics: { costEur: 0 } })
      expect(budget.reason).toContain('Unexpected serving client')
      expect(onStop).toHaveBeenCalledTimes(1)
    },
  )
  // The allowlist is the package's PRIVATE_TIER_CLIENTS, which the runner passes in
  // (#981 review NIT: it used to be a hand copy, and that copy had lost `LargeQwenThink`).
  // MUTATION: drop 'LargeQwenOR' from PRIVATE_TIER_CLIENTS in clients.server.ts, or
  // drop a thinking leaf from THINKING_CLIENTS → the enumeration below goes red, and
  // a route-switched or thinking-on eval stops on its first 27B-role call.
  it('admits exactly the clients the private tier can name, thinking leaves included', () => {
    expect([...PRIVATE_TIER_CLIENTS].sort()).toEqual([
      'LargeQwen',
      'LargeQwenOR',
      'LargeQwenThink',
      'LargeQwenThinkOR',
      'PrivateSystemOne',
      'SmallQwen',
    ])
  })
  it.each([...PRIVATE_TIER_CLIENTS])(
    'accepts every client the private-tier seam can name: %s',
    (clientName) => {
      const { budget, observer, onStop } = setup()
      observer.activate(key)
      observer.observe({ clientName, metrics: { costEur: 0 } })
      expect(onStop).not.toHaveBeenCalled()
      expect(budget.reason).toBeUndefined()
      expect(budget.totalUsd).toBe(0)
    },
  )
  it('stops usage outside the active scenario, including after deactivation', () => {
    const { budget, observer, onStop } = setup()
    observer.activate(key)
    observer.activate(undefined)
    observer.observe({ clientName: 'LargeQwen', metrics: { costEur: 0 } })
    expect(budget.reason).toBe('Usage outside a scenario')
    expect(onStop).toHaveBeenCalledTimes(1)
    expect(budget.rows).toHaveLength(0)
  })
  it('calls onStop synchronously at the 80% boundary', () => {
    const { budget, observer, onStop } = setup()
    observer.activate(key)
    observer.observe({ clientName: 'LargeQwen', metrics: { costEur: 12.8 } })
    expect(onStop).toHaveBeenCalledTimes(1)
    expect(budget.totalUsd).toBe(16)
  })
  it('stops missing live cost but permits scripted hermetic samples', () => {
    const live = setup()
    live.observer.activate(key)
    live.observer.observe({ clientName: 'PrivateSystemOne' })
    expect(live.onStop).toHaveBeenCalledOnce()
    const hermetic = setup(false)
    hermetic.observer.activate(key)
    hermetic.observer.observe({ clientName: 'SmallQwen' })
    expect(hermetic.budget.totalUsd).toBe(0)
    expect(hermetic.onStop).not.toHaveBeenCalled()
  })
  it('attributes each sample to its BAML function, not just to the scenario', () => {
    const { budget, observer } = setup()
    observer.activate(key)
    observer.observe({
      functionName: 'ScreenUntrustedContent',
      clientName: 'LargeQwen',
      metrics: { costEur: 0.2 },
    })
    observer.observe({
      functionName: 'Synthesize',
      clientName: 'LargeQwen',
      metrics: { costEur: 0.4 },
    })
    expect(budget.row(key).functions.ScreenUntrustedContent.calls).toBe(1)
    expect(budget.row(key).functions.ScreenUntrustedContent.observerUsd).toBeCloseTo(0.25)
    expect(budget.row(key).functions.Synthesize.calls).toBe(1)
  })
})

describe('a Decide sample is filed under its question key (boundary guards slice 3)', () => {
  // MUTATION: pass `sample.functionName` alone to the ledger: the gate's call is
  // filed with every other Decide call and its share cannot be told apart.
  it("the guard gate's Decide call is its own ledger line", () => {
    const { budget, observer } = setup()
    observer.activate(key)
    observer.observe({
      functionName: 'Decide',
      decisionKey: 'guard.screen',
      clientName: 'PrivateSystemOne',
      metrics: { costEur: 0.001 },
    })
    expect(Object.keys(budget.row(key).functions)).toEqual(['Decide:guard.screen'])
  })
})
