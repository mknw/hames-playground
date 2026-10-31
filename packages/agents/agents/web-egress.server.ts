/** One outbound policy for the web routes of the search and retriever agents. */
import { withEgressGate, GUARD_EGRESS_MAX_RETRIES_POST_TRIPWIRE } from '@hames-ai/harness-patterns'
import { createDecideAdapter } from '@hames-ai/harness-baml'
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import type { AgentDeps } from '../types'

assertServerOnImport()

export function webEgressGate(
  webTools: readonly string[],
  catalog: readonly string[],
  deps: AgentDeps,
) {
  return withEgressGate({
    local: [],
    catalog,
    fetchTools: webTools.filter((name) => name.includes('fetch')),
    addressSources: ['web'],
    roster: deps.egressRoster,
    decide: createDecideAdapter(),
    mode: deps.guards?.egressMode ?? 'filter',
    threshold: deps.guards?.egressThreshold,
    maxOutgoingRetriesPostTripwire:
      deps.guards?.maxOutgoingRetriesPostTripwire ?? GUARD_EGRESS_MAX_RETRIES_POST_TRIPWIRE,
    loadedDecideDown: 'by-shape',
    // These router agents cannot resume a held call; a refusal stays a refusal.
    askPerson: false,
  })
}
