/** #840 (residual of #507 run 9): the office route's deterministic result record —
 *  what `extractActorCritic` builds and Synthesize reads for a saved /work/out
 *  deliverable — ends in a fixed, echoable line stating the file is NOT indexed
 *  and the user can index it from the Data Stash. Run 9's failure was the
 *  synthesizer inverting its only truthful input (the critic's prose) into
 *  "Saved and indexed for this chat"; the record now carries the truth itself.
 *
 *  Scoped to the actorCritic record (the office route is the only decisionLoop
 *  route of that kind): a simpleLoop Return or a planner plan that mentions the
 *  same path carries no line. Verified by mutation below. */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

import { extract } from '@hames-ai/harness-patterns/patterns/decisionLoop-records.server'
import type { ContextEvent } from '@hames-ai/harness-patterns/types'

const LINE_FOR = (path: string): string =>
  `Saved to ${path} (not indexed by this route; the user can index it for search from the Data Stash)`

const ACTION = {
  tool_name: 'sandbox_bash',
  tool_args: "python3 - <<'PY'\nPath('/work/out/lantern-analysis.md').write_text('...')\nPY",
  reasoning: 'Wrote the analysis the user asked for.',
}

function officeEvents(stdout: string): ContextEvent[] {
  return [
    {
      type: 'controller_action',
      ts: 1,
      patternId: 'doc',
      data: { action: ACTION, turn: 0, maxTurns: 6 },
    },
    {
      type: 'tool_result',
      ts: 2,
      patternId: 'doc',
      data: {
        tool: 'sandbox_bash',
        result: { stdout, stderr: '', exit_code: 0, timed_out: false },
        success: true,
      },
    },
    {
      type: 'critic_result',
      ts: 3,
      patternId: 'doc',
      data: { result: { is_sufficient: true, explanation: 'The deliverable is complete.' } },
    },
  ]
}

describe('the actorCritic record carries the fixed saved-deliverable line (#840)', () => {
  it('ends in the line for a saved /work/out deliverable', () => {
    const found = extract('actorCritic', officeEvents('Saved /work/out/lantern-analysis.md'), 2000)
    expect(found.ok).toBe(true)
    if (!found.ok) return
    expect(found.result.endsWith(LINE_FOR('/work/out/lantern-analysis.md'))).toBe(true)
    // The quoted tool output is still there, ahead of the line.
    expect(found.result).toContain('Saved /work/out/lantern-analysis.md')
  })

  it('keeps the line within the record cap and budgets it off the quoted body', () => {
    const max = 300
    const found = extract('actorCritic', officeEvents('Saved /work/out/lantern-analysis.md'), max)
    if (!found.ok) return expect(found.ok).toBe(true)
    expect(found.result.length).toBeLessThanOrEqual(max)
    expect(found.result.endsWith(LINE_FOR('/work/out/lantern-analysis.md'))).toBe(true)
  })

  it('one line per distinct path, in first-appearance order; trailing punctuation is not part of a name', () => {
    const stdout = 'Saved /work/out/a-summary.md.\nAlso wrote /work/out/chart.png, done.'
    const found = extract('actorCritic', officeEvents(stdout), 2000)
    if (!found.ok) return expect(found.ok).toBe(true)
    expect(
      found.result.endsWith(
        `${LINE_FOR('/work/out/a-summary.md')}\n${LINE_FOR('/work/out/chart.png')}`,
      ),
    ).toBe(true)
    expect(found.result).not.toContain('a-summary.md. (')
  })

  it('no line when no accepted result names a /work/out deliverable', () => {
    const found = extract('actorCritic', officeEvents('Total: 66'), 2000)
    if (!found.ok) return expect(found.ok).toBe(true)
    expect(found.result).not.toContain('Data Stash')
    expect(found.result).toContain('Total: 66')
  })

  it('no line on OTHER routes: a simpleLoop Return or a planner plan naming the path carries none', () => {
    const loopEvents: ContextEvent[] = [
      {
        type: 'controller_action',
        ts: 1,
        patternId: 'info',
        data: {
          action: {
            tool_name: 'Return',
            tool_args: 'The file /work/out/a.md is ready.',
            is_final: true,
          },
        },
      },
    ]
    const loop = extract('simpleLoop', loopEvents, 2000)
    expect(loop.ok).toBe(true)
    if (loop.ok) expect(loop.result).not.toContain('Data Stash')
    const planEvents: ContextEvent[] = [
      {
        type: 'plan_created',
        ts: 1,
        patternId: 'think',
        data: { plan: { plan: '1. Save /work/out/a.md', n_steps: 1 } },
      },
    ]
    const plan = extract('planner', planEvents, 2000)
    expect(plan.ok).toBe(true)
    if (plan.ok) expect(plan.result).not.toContain('Data Stash')
  })

  // MUTATION: make `workOutSavedLines` return '' (or drop the appended suffix in
  // `extractActorCritic`) — every assertion above that expects the line goes red,
  // while the no-line cases stay green.
})
