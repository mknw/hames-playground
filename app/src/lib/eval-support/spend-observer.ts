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
      // The private-tier clients a completed call may name. The OpenRouter route
      // switch (`LARGE_LLM_ROUTE=openrouter`, packages/harness-baml/clients.server.ts
      // `largeClientForRole`) renames the 27B's serving client to its declared OR
      // twins — same endpoints contract, same no-caching posture, `zdr: true` on the
      // wire — so those two names ARE the private tier serving a call. Any other
      // unknown client is still the stop condition it always was: the allowlist must
      // not become allow-everything.
      if (
        !['LargeQwen', 'LargeQwenOR', 'LargeQwenThinkOR', 'SmallQwen', 'PrivateSystemOne'].includes(
          sample.clientName ?? '',
        )
      ) {
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
