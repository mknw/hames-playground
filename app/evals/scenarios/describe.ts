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
 *
 * WHICH CLIENT THIS GRADES matters more than it used to. Until 2026-08-26 the
 * describe role only ever resolved to an Anthropic chain; the private tier now
 * routes it to the 4B `LocalQwenSmall`, so this is the scenario standing in front
 * of "does a 4B keep the id discipline a 200B model kept". Run it with
 * `EVAL_CLIENT=tier` to grade the shipped route; the observations name the client
 * so a green cell cannot be mistaken for a green cell about a different model.
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
    const { expectedClientFor } = await import('../client')
    const { CLIENT_MAX_OUTPUT_TOKENS } = await import('../../src/lib/settings')
    const { maxBatchItems, MAX_BATCH_ITEMS } =
      await import('../../src/lib/harness-patterns/compactBulkData.server')
    const describeClient = expectedClientFor(ctx.routing, 'describe')
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
      // THE BATCH GEOMETRY IS DERIVED FROM THE CLIENT, and the derivation fails
      // OPEN: `maxBatchItems()` returns the full 8-item ceiling when the resolved
      // client has no `CLIENT_MAX_OUTPUT_TOKENS` entry. That is the worst possible
      // default for a small model — an 8-item batch on a 2 048-token cap truncates,
      // drops its tail summaries, and sends every dropped item down the per-item
      // fallback: N+1 calls, which is precisely the cost batching exists to avoid,
      // and it reads as a cost regression with no cause.
      //
      // It became a live risk with the 2026-08-26 describe flip, which is the
      // first time this role resolved to a client outside the Anthropic chains.
      // The unit suite pins today's two entries; this checks whatever client THIS
      // RUN was pointed at, on the machine the run happened on, which is the
      // moment a newly added one is discovered to be missing.
      check(
        `${describeClient} is visible to the batch-size derivation`,
        typeof CLIENT_MAX_OUTPUT_TOKENS[describeClient] === 'number',
        typeof CLIENT_MAX_OUTPUT_TOKENS[describeClient] === 'number'
          ? `max_tokens=${CLIENT_MAX_OUTPUT_TOKENS[describeClient]}`
          : `no CLIENT_MAX_OUTPUT_TOKENS entry — maxBatchItems() falls back to the full ` +
              `${MAX_BATCH_ITEMS}-item ceiling for a client whose cap nobody knows`,
      ),
    ]
    return {
      checks,
      collectors: [collector],
      observations: [
        // Which model this run actually graded. On the shipped tier
        // (`EVAL_CLIENT=tier`) this is the 4B and the heavy roles' scenarios say
        // the 27B — a divergence that is the point, not a mistake, and one the
        // report has to show rather than imply.
        { name: 'describe client under test', value: describeClient },
        { name: 'batch size it affords', value: String(maxBatchItems()) },
      ],
    }
  },
}
