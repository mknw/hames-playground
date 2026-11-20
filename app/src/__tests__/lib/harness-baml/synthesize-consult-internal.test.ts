/** #1058 (owner, on release): asked "What projects are active at DTSC?" the reply
 * said "no dedicated Project node… consult internal DTSC documentation" — a
 * deferral to internal documentation while the turn's own tools (the knowledge
 * graph, Microsoft 365 mail, calendar, files and sites) are exactly how such
 * documentation is read. The answer writer's rule: never send the user somewhere
 * a tool already looked; report what the tools found, including nothing found,
 * and name the sources that were searched.
 *
 * Offline wire renders, no model call — these tests do not measure a live
 * model's compliance.
 *
 * MUTATIONS (red): delete the "An organisation's own sources…" bullet from
 * `Synthesize` in `packages/harness-baml/baml_src/compact-execution.baml` and
 * regenerate — every client goes red; drop the "name the sources that were
 * searched" clause — the naming pin goes red; scope the rule to "projects" only —
 * the mail/calendar phrasing pin goes red. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { b } from '@hames-ai/harness-baml/baml_client'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))

const ENV = {
  ANTHROPIC_API_KEY: 'offline-render-test',
  LARGE_LLM_BASE_URL: 'https://example.invalid/v1',
  LARGE_LLM_API_KEY: 'offline-render-test',
}

beforeEach(() => {
  vi.stubEnv('USE_SELF_DEPLOYED_INFERENCE', '')
  vi.stubEnv('INFERENCE_TIERS', '')
})
afterEach(() => vi.unstubAllEnvs())

describe('Synthesize never defers the user to internal documentation a tool reads', () => {
  it.each(['AnthropicSonnet5', 'AnthropicHaiku45', 'LargeQwen'])(
    '%s carries the rule on the wire, over the organisation-source tools',
    async (client) => {
      const request = await b.request.Synthesize(
        'What projects are active at the organisation?',
        'List the active projects',
        [
          {
            n: 1,
            tool_result: {
              tool: 'read_neo4j_cypher',
              result: '[] — no Project nodes in the knowledge graph',
              success: true,
            },
          },
          {
            n: 2,
            tool_result: {
              tool: 'graph_files_search',
              result:
                '{"total":2,"results":[{"name":"lantern-portal-status.docx","snippet":"The Lantern Portal project is active."}]}',
              success: true,
            },
          },
        ],
        false,
        null,
        null, // memory_context
        null, // references
        null, // guide (#985)
        null, // current_time (#992): the options bag follows every optional slot
        { client, env: ENV },
      )
      // The rule is one bullet in the FIDELITY list; the rendered prompt wraps it,
      // so compare against the whitespace-normalised wire text.
      const text = request.body.text().replace(/\\n/g, ' ').replace(/\s+/g, ' ')
      expect(text).toContain(
        'An organisation’s own sources — its knowledge graph, its Microsoft 365 mail, calendar, files and sites — are read by the tools above.',
      )
      expect(text).toContain(
        'Never end the answer by telling the user to consult internal documentation, ask colleagues, or contact the organisation when those tools are how such documentation is read:',
      )
      expect(text).toContain(
        'report what the tools found (including that nothing was found) and name the sources that were searched, so the user is never sent somewhere a tool already looked.',
      )
    },
  )
})
