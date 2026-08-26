/**
 * Synthesize — the compactExecution response.
 *
 * The synthesizer is the last call of a turn and the only one whose output the
 * user reads directly, which makes its failure mode the most expensive in the
 * repo: it can invent. The tool log below carries four specific, checkable
 * facts and one hole. A synthesizer that is grounded reports the four and says
 * the fifth is missing; one that is not fills the hole in with something
 * plausible, and nothing downstream can tell.
 *
 * So the checks are all about GROUNDING, not about prose quality:
 *  - the numbers that were in the log appear in the answer
 *  - a number that was NOT in the log does not
 *  - the error branch is acknowledged rather than papered over
 */

import { Collector } from '@boundaryml/baml'
import type { LoopTurn } from '../../baml_client/types'
import { check, type Check, type Scenario } from '../harness'

const TURNS: LoopTurn[] = [
  {
    n: 0,
    reasoning: 'Count the nodes by label.',
    status: 'Counting nodes...',
    tool_call: {
      tool: 'read_neo4j_cypher',
      args: '{"query":"MATCH (n) RETURN labels(n)[0] AS label, count(*) AS n"}',
    },
    tool_result: {
      tool: 'read_neo4j_cypher',
      success: true,
      result:
        '[{"label":"Person","n":417},{"label":"Organisation","n":63},' +
        '{"label":"Document","n":1288}]',
    },
  },
  {
    n: 1,
    reasoning: 'Also fetch the relationship counts.',
    status: 'Counting relationships...',
    tool_call: {
      tool: 'read_neo4j_cypher',
      args: '{"query":"MATCH ()-[r]->() RETURN type(r) AS t, count(*) AS n"}',
    },
    tool_result: {
      tool: 'read_neo4j_cypher',
      success: false,
      result: '',
      error: 'Neo.TransientError.Transaction.Terminated — query exceeded the 30s timeout',
    },
  },
]

export const synthesizerGroundedScenario: Scenario = {
  id: 'synthesizer-grounded-summary',
  role: 'compactExecution',
  title: 'Synthesize — grounded summary over a partial tool log',
  what: 'reports the counts that are in the log, does not invent the one that is missing, and admits the failed call',
  run: async (ctx) => {
    const { b } = await import('../../baml_client')
    const collector = new Collector('eval-synthesize-grounded')
    const answer = await b.Synthesize(
      'How big is the graph?',
      'report the node and relationship counts in the graph',
      TURNS,
      true,
      'The relationship count query timed out after 30s.',
      ctx.opts('compactExecution', collector),
    )
    const checks: Check[] = []
    const digits = answer.replace(/[^\d]/g, ' ')

    // Every number that WAS in the log has to survive into the answer —
    // a summary that drops two of three counts answered a smaller question.
    for (const n of ['417', '63', '1288']) {
      checks.push(
        check(
          `reports the ${n} count from the log`,
          new RegExp(`\\b${n}\\b`).test(answer.replace(/,/g, '')),
          `"${n}" ${new RegExp(`\\b${n}\\b`).test(answer.replace(/,/g, '')) ? 'present' : 'ABSENT'}`,
        ),
      )
    }
    // GROUNDING, as a whitelist. Every multi-digit figure in the answer must
    // trace back to the log: one of the three counts, a legitimate sum of them,
    // or the timeout the error itself names. Anything else was invented — and
    // the relationship counts, whose query failed, are the hole a synthesizer
    // fills in when it is not grounded.
    //
    // This started as "no digits near the word relationship", which was wrong
    // in BOTH directions and is worth recording: it went red on the first
    // baseline run against a CORRECT answer (the "30 seconds" in "the query
    // timed out after 30 seconds" sits beside the word), and a windowed version
    // then let a fabricated `- WORKS_FOR: 412` list through, because the lines
    // carrying the invented numbers never say "relationship" at all. A
    // whitelist has neither failure mode: it does not care where a number
    // appears, only whether the log could have produced it.
    const grounded = new Set([
      417,
      63,
      1288, // the three counts the log returned
      30, // the timeout named in the error message
      417 + 63,
      63 + 1288,
      417 + 1288,
      417 + 63 + 1288, // totals a grounded answer may legitimately derive
    ])
    const ungrounded: string[] = []
    for (const m of answer.replace(/,(?=\d{3}\b)/g, '').matchAll(/\b(\d{2,})\b(\s*%)?/g)) {
      // A percentage is derived from the counts rather than asserted as data,
      // so it is not evidence of invention.
      if (m[2]) continue
      if (!grounded.has(Number(m[1]))) {
        ungrounded.push(
          `${m[1]} in "${answer
            .slice(Math.max(0, m.index - 45), m.index + 25)
            .replace(/\s+/g, ' ')
            .trim()}"`,
        )
      }
    }
    checks.push(
      check(
        'every figure traces back to the log',
        ungrounded.length === 0,
        ungrounded.length > 0
          ? `invented: ${ungrounded.slice(0, 3).join(' · ')}`
          : 'no figure outside the counts, their sums, and the timeout',
      ),
    )
    checks.push(
      check(
        'acknowledges the failed call',
        /(time(d)? ?out|timeout|fail|error|could not|unable|unavailable)/i.test(answer),
        `answer=${JSON.stringify(answer.slice(0, 300))}`,
      ),
    )
    checks.push(
      check(
        'returned non-empty prose',
        answer.trim().length > 40,
        `${answer.trim().length} chars${digits.trim() ? '' : ' (no digits at all)'}`,
      ),
    )
    return { checks, collectors: [collector] }
  },
}
