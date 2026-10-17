import { describe, it, expect, vi } from 'vitest'
import { SpendBudget, type SpendKey } from '../../../lib/eval-support/spend-budget'
import { createSpendObserver } from '../../../lib/eval-support/spend-observer'
const key: SpendKey = { agent: 'general-next', scenario: 'test', tier: 'verda' }
const setup = (live = true) => {
  const budget = new SpendBudget(20, 0.8)
  const onStop = vi.fn()
  return { budget, onStop, observer: createSpendObserver({ budget, live, onStop }) }
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
  it('stops usage outside the active scenario, including after deactivation', () => {
    const { budget, observer, onStop } = setup()
    observer.activate(key)
    observer.activate(undefined)
    observer.observe({ clientName: 'VerdaQwen', metrics: { costEur: 0 } })
    expect(budget.reason).toBe('Usage outside a scenario')
    expect(onStop).toHaveBeenCalledTimes(1)
    expect(budget.rows).toHaveLength(0)
  })
  it('calls onStop synchronously at the 80% boundary', () => {
    const { budget, observer, onStop } = setup()
    observer.activate(key)
    observer.observe({ clientName: 'VerdaQwen', metrics: { costEur: 12.8 } })
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
    hermetic.observer.observe({ clientName: 'LocalQwenSmall' })
    expect(hermetic.budget.totalUsd).toBe(0)
    expect(hermetic.onStop).not.toHaveBeenCalled()
  })
  it('attributes each sample to its BAML function, not just to the scenario', () => {
    const { budget, observer } = setup()
    observer.activate(key)
    observer.observe({
      functionName: 'ScreenUntrustedContent',
      clientName: 'VerdaQwen',
      metrics: { costEur: 0.2 },
    })
    observer.observe({
      functionName: 'Synthesize',
      clientName: 'VerdaQwen',
      metrics: { costEur: 0.4 },
    })
    expect(budget.row(key).functions.ScreenUntrustedContent.calls).toBe(1)
    expect(budget.row(key).functions.ScreenUntrustedContent.observerUsd).toBeCloseTo(0.25)
    expect(budget.row(key).functions.Synthesize.calls).toBe(1)
  })
})
