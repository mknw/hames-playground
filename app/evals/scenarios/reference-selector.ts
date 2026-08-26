/**
 * ReferenceSelector — the citation picker, and the least summarization-like of
 * the six functions on the `describe` role.
 *
 * WHY IT EXISTS. The 2026-08-26 flip moved all six describe functions onto the
 * 4B, and until this file the suite graded exactly one of them
 * (`ResultDescribeBatch`). #279's review named the asymmetry: the `screen` move
 * got its own scenario and the standing rule that a failing run is evidence the
 * move was wrong, while the flip that moved six functions had one. This is the
 * first of the three that were uncovered, and it is the one worth doing first
 * because it is not a summarization task at all — it is a RETRIEVAL judgement
 * returning IDS, and the failure it can produce is the kind a small model
 * produces most readily.
 *
 * WHAT IT GRADES, and why on shape rather than on taste. `withReferences` takes
 * `selected[].ref_id` and attaches the matching prior tool results to the next
 * pattern's ingress. Two properties are load-bearing there and neither is a
 * matter of opinion:
 *
 *  1. **Every returned id is one of the candidates.** An invented or
 *     hallucinated id attaches nothing, so the pattern runs as if no reference
 *     applied — the failure is a MISSING citation, silently, on a turn the user
 *     asked a follow-up question about.
 *  2. **The obviously-relevant candidate is picked, and the unrelated ones are
 *     not all picked.** "Select nothing" and "select everything" are both ways
 *     of not making the judgement, and each looks like a working call: the first
 *     drops the context, the second re-attaches every stale result in the
 *     conversation and spends the controller's window on it.
 *
 * The intent below is deliberately unambiguous about which candidate matters,
 * so a red cell is a finding about the model rather than a disagreement about
 * relevance. Wording, ranking beyond first place, and the `reasoning` prose are
 * NOT graded — they are what a model is allowed to differ on.
 */

import { Collector } from '@boundaryml/baml'
import { check, type Check, type Scenario } from '../harness'

/** The one candidate that answers the intent, plus two that plainly do not. */
const RELEVANT = 'ev-cypher-7'

const CANDIDATES = [
  {
    ref_id: 'ev-weather-2',
    tool: 'fetch',
    summary: 'Weather forecast for Brussels: 14°C, light rain through Thursday.',
    tool_args: '{"url":"https://example.com/weather/brussels"}',
    ts_offset_s: 900,
  },
  {
    ref_id: RELEVANT,
    tool: 'read_neo4j_cypher',
    summary:
      'Result of MATCH (p:Person)-[:WORKS_ON]->(pr:Project) RETURN p.name, pr.name — 12 rows ' +
      'pairing people with the projects they work on, including Ada Lovelace on "Atlas".',
    tool_args: '{"query":"MATCH (p:Person)-[:WORKS_ON]->(pr:Project) RETURN p.name, pr.name"}',
    ts_offset_s: 120,
  },
  {
    ref_id: 'ev-pizza-9',
    tool: 'search',
    summary: 'Lunch options near the office: three pizzerias with opening hours.',
    tool_args: '{"query":"lunch near office"}',
    ts_offset_s: 300,
  },
]

const INTENT = 'Which project was Ada Lovelace working on, according to the graph query I ran?'

const RECENT_MESSAGES = [
  { role: 'user', content: 'Query the graph for who works on which project.' },
  {
    role: 'assistant',
    content: 'I ran a Cypher query and found 12 person-to-project pairs.',
  },
]

export const referenceSelectorScenario: Scenario = {
  id: 'reference-selector-ids',
  role: 'describe',
  title: 'ReferenceSelector — picks the relevant prior result, and only real ids',
  what: 'the citation picker: an invented ref_id attaches nothing, so a missing citation is the silent failure',
  run: async (ctx) => {
    const { b } = await import('../../baml_client')
    const { expectedClientFor } = await import('../client')
    const describeClient = expectedClientFor(ctx.routing, 'describe')
    const collector = new Collector('eval-reference-selector')

    const result = await b.ReferenceSelector(
      INTENT,
      RECENT_MESSAGES,
      CANDIDATES,
      ctx.opts('describe', collector),
    )
    const selected = result?.selected ?? []
    const ids = selected.map((s) => s.ref_id)
    const known = new Set(CANDIDATES.map((c) => c.ref_id))
    const invented = ids.filter((id) => !known.has(id))

    const checks: Check[] = [
      // The one failure `withReferences` cannot recover from: it looks up each
      // id in the candidate set and attaches what it finds, so an id that is not
      // there produces no attachment and no error.
      check(
        'every returned ref_id is a real candidate',
        invented.length === 0,
        invented.length ? `invented ${invented.join(', ')}` : `all of ${ids.join(', ') || 'none'}`,
      ),
      check(
        'the relevant result was selected',
        ids.includes(RELEVANT),
        ids.length ? `selected ${ids.join(', ')}` : 'selected nothing',
      ),
      // Ranked most-relevant first is the declared contract, and the wrapper
      // relies on it when it has to truncate.
      check(
        'the relevant result is ranked first',
        ids[0] === RELEVANT,
        ids.length ? `first was ${ids[0]}` : 'nothing was returned',
      ),
      // Not "exactly one": the prompt says to include anything plausibly useful,
      // and a second pick is a judgement call. Taking ALL THREE is not — it is
      // the model declining to choose, which re-attaches the weather and the
      // pizzerias to a graph question.
      check(
        'the plainly unrelated candidates were not all attached',
        ids.length < CANDIDATES.length,
        `${ids.length} of ${CANDIDATES.length} candidates selected`,
      ),
      check(
        'each selection carries a reason',
        selected.every((s) => (s.reason ?? '').trim().length > 0),
        `${selected.filter((s) => (s.reason ?? '').trim().length === 0).length} blank`,
      ),
    ]

    return {
      checks,
      collectors: [collector],
      observations: [
        { name: 'describe client under test', value: describeClient },
        { name: 'selected', value: ids.join(', ') || '(none)' },
      ],
    }
  },
}
