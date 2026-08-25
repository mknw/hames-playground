/**
 * Structured-output reliability — N controller-shaped calls, counted.
 *
 * Every other scenario asks "does this branch work". This one asks "how often".
 * The repo's recurring production failure is not a wrong answer, it is an
 * UNPARSEABLE one: a brace-less envelope copied from a stale few-shot, an
 * action cut off mid-JSON, a thinking block ahead of the object. Each of those
 * throws a `BamlValidationError` that the loop turns into a wasted round trip,
 * and none of them shows up in a single happy-path call — a client that fails
 * one turn in fifteen passes every scenario in this suite and still makes the
 * product feel broken.
 *
 * So: the same controller prompt, N times, counting parse failures. The prompt
 * is deliberately the AWKWARD one — a tool whose arguments need real JSON
 * escaping (a quoted Cypher string inside a JSON string inside the envelope),
 * which is the shape that historically produces the malformed actions.
 *
 * The result is a RATE, reported as an observation with the raw counts beside
 * it, plus one check: the run produced at least one valid action. Choosing a
 * pass/fail threshold for a reliability rate is an owner decision — a client at
 * 19/20 may be fine behind the corrective retry and unacceptable without it —
 * so the suite measures and reports rather than deciding.
 *
 * `EVAL_RELIABILITY_N` overrides the count (default 20; 0 skips the scenario's
 * calls entirely, for a quick structural-only run).
 */

import { Collector } from '@boundaryml/baml'
import type { ToolDescription } from '../../baml_client/types'
import { check, rawCompletion, usageOf, type Scenario } from '../harness'

const TOOLS: ToolDescription[] = [
  {
    name: 'read_neo4j_cypher',
    description: 'Run a READ-ONLY Cypher query against the graph and return rows.',
    args_schema: JSON.stringify({
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    }),
  },
  {
    name: 'search_documents',
    description: 'Full-text search over the stashed documents. Takes a query and a limit.',
    args_schema: JSON.stringify({
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'integer' } },
      required: ['query'],
    }),
  },
]

/** Needs a quoted string inside a Cypher string inside a JSON string inside the
 *  envelope — three levels of escaping, which is where malformed actions come
 *  from. */
const USER_MESSAGE =
  'Which people are linked to the organisation named "Acme, Inc." — and what is the ' +
  'relationship type called?'
const INTENT =
  'find people related to the organisation literally named `Acme, Inc.` and report the ' +
  'relationship type'

export function reliabilityCount(): number {
  const raw = process.env.EVAL_RELIABILITY_N
  if (raw === undefined) return 20
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`EVAL_RELIABILITY_N must be a non-negative integer, got ${JSON.stringify(raw)}`)
  }
  return n
}

export const reliabilityScenario: Scenario = {
  id: 'controller-structured-output-reliability',
  role: 'controller',
  title: `Structured-output reliability — ${reliabilityCount()} controller calls`,
  what: 'parse-failure rate on the escaping-heavy envelope, the shape malformed actions come from',
  run: async (ctx) => {
    const n = reliabilityCount()
    const { b } = await import('../../baml_client')
    let parsed = 0
    const failures: string[] = []
    let outputTokens = 0
    let thinkingLeaks = 0
    const collectors: Collector[] = []

    for (let i = 0; i < n; i++) {
      const collector = new Collector(`eval-reliability-${i}`)
      // Only the first collector is reported — N of them would bury the table
      // in identical rows — but every call is counted below.
      if (i === 0) collectors.push(collector)
      try {
        const action = await b.LoopController(
          USER_MESSAGE,
          INTENT,
          TOOLS,
          [],
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          ctx.opts('controller', collector),
        )
        // Parsing into the type is most of the result, but an action whose
        // `tool_args` is not JSON still fails at dispatch time — count it as a
        // failure here rather than letting a technically-valid envelope with
        // unusable contents inflate the rate.
        if (action.tool_name !== 'Return') {
          JSON.parse(action.tool_args)
        }
        parsed++
      } catch (err) {
        failures.push(
          `#${i}: ${err instanceof Error ? `${err.name}: ${err.message.split('\n')[0]}` : String(err)}`,
        )
      }
      if (/<\/think>/i.test(rawCompletion(collector) ?? '')) thinkingLeaks++
      outputTokens += usageOf(collector)?.output ?? 0
    }

    const rate = n === 0 ? 'n/a' : `${parsed}/${n} (${((parsed / n) * 100).toFixed(1)}%)`
    return {
      collectors,
      checks: [
        // Deliberately a floor, not a threshold: see the header. Zero valid
        // actions out of N is not a rate, it is a broken client.
        check(
          'produced at least one valid action',
          n === 0 || parsed > 0,
          n === 0 ? 'skipped (EVAL_RELIABILITY_N=0)' : `${rate} parsed`,
        ),
      ],
      observations: [
        { name: 'valid actions', value: rate },
        {
          name: 'parse failures',
          value: failures.length === 0 ? 'none' : failures.slice(0, 5).join(' · '),
        },
        { name: 'thinking leaks', value: `${thinkingLeaks}/${n}` },
        {
          name: 'mean output tokens',
          value: n === 0 ? 'n/a' : `${Math.round(outputTokens / n)}`,
        },
      ],
    }
  },
}
