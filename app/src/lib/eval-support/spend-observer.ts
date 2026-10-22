import { ledgerFunction, type SpendBudget, type SpendKey } from './spend-budget'

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
    observe(sample: {
      functionName?: string
      decisionKey?: string
      clientName?: string
      metrics?: { costEur?: number }
    }) {
      if (!active) {
        budget.reason = 'Usage outside a scenario'
        onStop()
        return
      }
      if (!['LargeQwen', 'SmallQwen', 'PrivateSystemOne'].includes(sample.clientName ?? '')) {
        budget.reason = 'Unexpected serving client on the private tier'
        onStop()
        return
      }
      budget.observe(
        active,
        live ? sample.metrics : { costEur: 0 },
        ledgerFunction(sample.functionName, sample.decisionKey),
      )
      if (budget.stopped) onStop()
    },
  }
}
