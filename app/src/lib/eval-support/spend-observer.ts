import type { SpendBudget, SpendKey } from './spend-budget'

/** onStop MUST terminate synchronously: the production notifier swallows throws. */
export function createSpendObserver({
  budget,
  live,
  onStop,
}: {
  budget: SpendBudget
  live: boolean
  onStop: () => void
}) {
  let active: SpendKey | undefined
  return {
    activate(key: SpendKey | undefined) {
      active = key
    },
    observe(sample: { clientName?: string; metrics?: { costEur?: number } }) {
      if (!active) {
        budget.reason = 'Usage outside a scenario'
        onStop()
        return
      }
      if (!['VerdaQwen', 'LocalQwenSmall', 'PrivateSystemOne'].includes(sample.clientName ?? '')) {
        budget.reason = 'Unexpected serving client on the private tier'
        onStop()
        return
      }
      budget.observe(active, live ? sample.metrics : { costEur: 0 })
      if (budget.stopped) onStop()
    },
  }
}
