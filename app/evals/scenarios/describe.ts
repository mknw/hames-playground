/**
 * ResultDescribeBatch — the compactBulkData batch shape.
 *
 * `describeToolResultsBatchOp` summarizes several tool results in ONE call and
 * matches them back up by a caller-assigned `id`. That id discipline is the
 * whole contract: an unknown id is DISCARDED rather than guessed at, so a model
 * that relabels its answers does not attach one tool's summary to another tool's
 * result — it just silently produces fewer summaries, and the caller falls back
 * to one call per item (an N+1 that reads as a cost regression with no cause).
 *
 * So the checks are on the batch's SHAPE, not on the summaries' wording: one
 * summary per item, ids echoed verbatim, nothing invented, nothing dropped.
 * That is precisely what moves when a client changes.
 */

import { Collector } from '@boundaryml/baml'
import type { DescribeTarget } from '../../baml_client/types'
import { check, type Check, type Scenario } from '../harness'

const ITEMS: DescribeTarget[] = [
  {
    id: 'r1',
    tool: 'read_neo4j_cypher',
    tool_args: '{"query":"MATCH (p:Person) RETURN p.name LIMIT 3"}',
    reasoning: 'List a few people to confirm the label is populated.',
    result: '[{"p.name":"Ada Lovelace"},{"p.name":"Grace Hopper"},{"p.name":"Alan Turing"}]',
  },
  {
    id: 'r2',
    tool: 'search',
    tool_args: '{"query":"SolidStart server actions"}',
    reasoning: 'Find current documentation for server actions.',
    result:
      'Top result: "Server Actions | SolidStart" — describes the "use server" directive, ' +
      'form actions, and the useAction/useSubmission hooks. 4 further results omitted.',
  },
  {
    id: 'r3',
    tool: 'list_directory',
    tool_args: '{"path":"/work"}',
    reasoning: 'See what the sandbox workspace already holds.',
    result: 'data.csv (48KB)\nnotes.md (2KB)\nout/ (dir)',
  },
]

export const describeBatchScenario: Scenario = {
  id: 'describe-batch-shape',
  role: 'describe',
  title: 'ResultDescribeBatch — one summary per item, ids echoed verbatim',
  what: 'the id-keyed batch contract compactBulkData depends on: drop an id and the caller silently falls back to N+1 calls',
  run: async (ctx) => {
    const { b } = await import('../../baml_client')
    const collector = new Collector('eval-describe-batch')
    const batch = await b.ResultDescribeBatch(ITEMS, ctx.opts('describe', collector))
    const summaries = batch?.summaries ?? []
    const returnedIds = summaries.map((s) => s.id)
    const wanted = ITEMS.map((i) => i.id)
    const missing = wanted.filter((id) => !returnedIds.includes(id))
    const unknown = returnedIds.filter((id) => !wanted.includes(id))
    const checks: Check[] = [
      check(
        'exactly one summary per item',
        summaries.length === ITEMS.length,
        `${summaries.length} summaries for ${ITEMS.length} items`,
      ),
      check(
        'every id was echoed back',
        missing.length === 0,
        missing.length ? `missing ${missing.join(', ')}` : `all of ${wanted.join(', ')}`,
      ),
      check(
        'no ids were invented',
        unknown.length === 0,
        unknown.length ? `unknown ${unknown.join(', ')} (these get discarded)` : 'none',
      ),
      check(
        'no summary is blank',
        summaries.every((s) => (s.summary ?? '').trim().length > 0),
        `${summaries.filter((s) => (s.summary ?? '').trim().length === 0).length} blank`,
      ),
    ]
    return { checks, collectors: [collector] }
  },
}
