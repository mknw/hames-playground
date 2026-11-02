/** Slice 15's deterministic recall observation. Synthetic directory rows only;
 * no model, tenant, or network. Misses are measurements, never a pass bar. */
import { createContext, createScope } from '@hames-ai/harness-patterns/context.server'
import { configurePattern } from '@hames-ai/harness-patterns/patterns/chain.server'
import { createEventView } from '@hames-ai/harness-patterns/patterns/event-view.server'
import { withEgressGate } from '@hames-ai/harness-patterns/patterns/withEgressGate.server'
import { callTool } from '@hames-ai/harness-patterns/mcp-client.server'
import { amendRunFrame } from '@hames-ai/harness-patterns/run-frame.server'
import type { EgressRosterSource } from '@hames-ai/harness-patterns'

export const NAME_RECALL_DIRECTORY = [
  { displayName: 'Mira Cedar', mail: 'mira.cedar@example.test' },
]
export const NAME_RECALL_DETECTORS = { nameMatch: 'refuse', decide: 'off' } as const
export const NAME_RECALL_FIXTURES = [
  { id: 'literal-control', query: 'Mira Cedar' },
  // Cyrillic i and e replace Latin letters in BOTH parts of the name.
  { id: 'homoglyph', query: 'M\u0456ra C\u0435dar' },
  { id: 'letter-by-letter', query: 'M i r a C e d a r' },
] as const

/** The real host matcher, seeded with synthetic directory-shaped identity
 * payloads instead of tenant I/O. The offline pin compares this with the real
 * directory-loading path supplied the same rows. Only the source status is
 * synthetic; matching and the gate are production code. */
export const syntheticNameRecallRoster =
  (source: EgressRosterSource): EgressRosterSource =>
  async (payloads, user) => ({
    ...(await source([NAME_RECALL_DIRECTORY, ...payloads], user)),
    directory: 'loaded',
  })

export async function measureNameListRecall(roster: EgressRosterSource) {
  const observations: { name: string; value: string }[] = []
  for (const row of NAME_RECALL_FIXTURES) {
    let dispatched = 0
    const probe = configurePattern('name-recall', async (scope) => {
      await callTool('web_search', { query: row.query })
      return scope
    })
    const gate = withEgressGate({
      local: [],
      catalog: ['web_search'],
      detectors: { default: NAME_RECALL_DETECTORS },
      roster,
    })(probe)
    const scope = await amendRunFrame(
      {
        transports: [
          {
            id: 'name-recall-synthetic',
            ownsTool: () => true,
            listTools: async () => [],
            callTool: async () => {
              dispatched++
              return { success: true, data: 'synthetic result' }
            },
          },
        ],
      },
      () =>
        gate.fn(
          createScope('name-recall', {}),
          createEventView(createContext('Find public guidance.')),
        ),
    )
    const recalled = scope.events.some(
      (e) => e.type === 'egress_blocked' && (e.data as { rule: string }).rule === 'name-match',
    )
    const decisions = scope.events.filter((e) => e.type === 'decision_made').length
    observations.push({
      name: `name-list recall, ${row.id} (refuse/off; observation only)`,
      value: `${Number(recalled)}/1; dispatched=${dispatched}; decide calls=${decisions}`,
    })
  }
  return observations
}
