/**
 * actorCritic — propose, judge, revise.
 *
 * Two branches, and the second is the one that matters. A critic that accepts
 * everything makes the pattern an expensive simpleLoop; a critic that rejects
 * everything makes it a budget burner. So the pair below is deliberately
 * asymmetric: one attempt that plainly satisfies the intent (expect ACCEPT) and
 * one that plainly does not (expect REJECT, and the rejection has to carry
 * enough for the actor to do something different next).
 *
 * The revise half then feeds that rejection back as `Attempt.feedback` — the
 * field that was hardcoded `undefined` for a while (SA-C1), which made the
 * actor prompt's CRITIC FEEDBACK block dead code and every retry blind. The
 * check is that the second proposal actually MOVES: same intent, same tools, a
 * critic note saying what was wrong, and an action that is not the rejected one
 * repeated verbatim.
 */

import { Collector } from '@boundaryml/baml'
import type { Attempt, ToolDescription } from '../../baml_client/types'
import { check, type Check, type Scenario } from '../harness'

const TOOLS: ToolDescription[] = [
  {
    name: 'sandbox_bash',
    description: 'Run a shell command inside the sandbox and return stdout/stderr.',
    args_schema: JSON.stringify({
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    }),
  },
]

const INTENT = 'count how many lines in data.csv have a non-empty "email" column'

/** Plainly sufficient: the command answers the intent and the output is a
 *  number. A critic that rejects this is over-rejecting. */
const GOOD_ATTEMPT: Attempt = {
  n: 1,
  action: {
    reasoning: 'Skip the header, count rows whose email field is non-empty.',
    tool_name: 'sandbox_bash',
    tool_args: JSON.stringify({
      command: 'awk -F, \'NR>1 && $3 != "" {c++} END {print c}\' data.csv',
    }),
    status: 'Counting rows with an email...',
    is_final: false,
  },
  result: '842',
}

/** Plainly insufficient: it counted ALL rows, not the ones with an email, so
 *  the number answers a different question. A critic that accepts this is
 *  rubber-stamping. */
const BAD_ATTEMPT: Attempt = {
  n: 1,
  action: {
    reasoning: 'Count the lines in the file.',
    tool_name: 'sandbox_bash',
    tool_args: JSON.stringify({ command: 'wc -l data.csv' }),
    status: 'Counting lines...',
    is_final: false,
  },
  result: '1000 data.csv',
}

export const criticAcceptScenario: Scenario = {
  id: 'critic-accepts-sufficient-attempt',
  role: 'critic',
  title: 'actorCritic — critic accepts a sufficient attempt',
  what: 'an attempt that answers the intent is passed, so the pattern is not an expensive simpleLoop',
  run: async (ctx) => {
    const { b } = await import('../../baml_client')
    const collector = new Collector('eval-critic-accept')
    const result = await b.Critic(INTENT, [GOOD_ATTEMPT], ctx.opts('critic', collector))
    return {
      collectors: [collector],
      checks: [
        check(
          'is_sufficient parses as a boolean',
          typeof result.is_sufficient === 'boolean',
          `is_sufficient=${JSON.stringify(result.is_sufficient)}`,
        ),
        check(
          'accepted the sufficient attempt',
          result.is_sufficient === true,
          `is_sufficient=${result.is_sufficient} explanation=${JSON.stringify(result.explanation.slice(0, 200))}`,
        ),
      ],
    }
  },
}

export const criticRejectAndReviseScenario: Scenario = {
  id: 'critic-rejects-then-actor-revises',
  role: 'actor',
  title: 'actorCritic — critic rejects, actor revises',
  what: 'a wrong-but-successful attempt is rejected, and the rejection reaches the actor as feedback that changes the next proposal (SA-C1)',
  run: async (ctx) => {
    const { b } = await import('../../baml_client')
    const checks: Check[] = []
    const collectors: Collector[] = []

    // 1. The critic has to reject an attempt that SUCCEEDED but answered the
    //    wrong question. Exit status is not sufficiency.
    const criticCollector = new Collector('eval-critic-reject')
    collectors.push(criticCollector)
    const verdict = await b.Critic(INTENT, [BAD_ATTEMPT], ctx.opts('critic', criticCollector))
    checks.push(
      check(
        'rejected the wrong-but-successful attempt',
        verdict.is_sufficient === false,
        `is_sufficient=${verdict.is_sufficient} explanation=${JSON.stringify(verdict.explanation.slice(0, 200))}`,
      ),
    )
    checks.push(
      check(
        'the rejection says something actionable',
        verdict.explanation.trim().length > 20,
        `explanation is ${verdict.explanation.trim().length} chars`,
      ),
    )

    // 2. Feed the rejection back the way the adapter does — on
    //    `Attempt.feedback`, the field the actor prompt's CRITIC FEEDBACK block
    //    renders. A revision that repeats the rejected command verbatim means
    //    the feedback did not land.
    const actorCollector = new Collector('eval-actor-revise')
    collectors.push(actorCollector)
    const rejected: Attempt = {
      ...BAD_ATTEMPT,
      feedback: verdict.suggested_approach ?? verdict.explanation,
    }
    const revised = await b.ActorController(
      INTENT,
      INTENT,
      TOOLS,
      [rejected],
      undefined, // context
      undefined, // few_shots
      2, // attempt_n
      3, // max_attempts
      undefined, // multi_call_mode
      ctx.opts('actor', actorCollector),
    )
    const sameCommand =
      revised.tool_args.replace(/\s+/g, '') === BAD_ATTEMPT.action.tool_args.replace(/\s+/g, '')
    checks.push(
      check(
        'the revised proposal is not the rejected one repeated',
        !sameCommand,
        `revised tool_args=${JSON.stringify(revised.tool_args.slice(0, 200))}`,
      ),
    )
    checks.push(
      check(
        'the revised action parses into the envelope',
        typeof revised.tool_name === 'string' && typeof revised.reasoning === 'string',
        `tool_name=${JSON.stringify(revised.tool_name)}`,
      ),
    )
    return { checks, collectors }
  },
}
