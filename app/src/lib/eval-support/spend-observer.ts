import { ledgerFunction, type SpendBudget, type SpendKey } from './spend-budget'

/** onStop MUST terminate synchronously: the production notifier swallows throws. */
export function createSpendObserver({
  budget,
  live,
  onStop,
  privateClients,
}: {
  budget: SpendBudget
  live: boolean
  onStop: () => void
  /** `PRIVATE_TIER_CLIENTS` from `@hames-ai/harness-baml/clients.server`. */
  privateClients: ReadonlySet<string>
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
      // The private-tier clients a completed call may name: the package's own
      // `PRIVATE_TIER_CLIENTS` (the tier map's values, the thinking leaves and the
      // OpenRouter twin), passed in by the runner rather than copied here — a hand
      // copy is how the box route's `LargeQwenThink` went missing while its OR twin
      // was admitted. Any other client is still the stop condition: the set is the
      // private tier's, never allow-everything.
      if (!privateClients.has(sample.clientName ?? '')) {
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
