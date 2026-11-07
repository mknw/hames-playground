/** #1017 review: the `withBudget` guards the PR shipped with no discriminating
 *  test. Each case names the source mutation that must redden it:
 *  G1 removes the bounded-loop-route refusal, G2 the committed-history
 *  refusal, G3 the route-composition check. (The boundary-segment validation
 *  in `replayIterations` is verified redundant with `checkResume`'s
 *  `followContinuation` — see the review comment — so it gets no case here.) */
import { describe, expect, it, vi } from 'vitest'
import { harness, resumeHarness } from '../harness.server'
import { readHitl } from '../hitl.server'
import { decisionLoop, type DecisionLoopRoute } from '../patterns/decisionLoop.server'
import { simpleLoop } from '../patterns/simpleLoop.server'
import { type RunFrame } from '../run-frame.server'
import type {
  ConfiguredPattern,
  ControllerInput,
  DecideFn,
  DecideInput,
  PatternScope,
} from '../types'

type Data = Record<string, unknown> & { response?: string }
const act = () => ({
  action: { tool_name: 'read', tool_args: '{}', reasoning: 'Synthetic work', is_final: false },
})

const decide = vi.fn(async ({ spec }: DecideInput<string>) => ({
  probs: Object.fromEntries(
    ('labels' in spec ? spec.labels : []).map((l) => [l.id, l.id === 'work' ? 1 : 0]),
  ),
  method: 'jev' as const,
  calibrated: false,
})) as DecideFn

const make = (patternId = 'work', maxTurns = 1): ConfiguredPattern<Data> =>
  simpleLoop<Data>(async (_input: ControllerInput) => act(), ['read'], {
    patternId,
    maxTurns,
    returnStyle: 'answer',
    rememberPriorTurns: false,
  })

/** A route leaf the loop reads as a `planner` — built as a bare object, since
 *  the refusal under test keys on the unwrapped leaf's NAME, not on a real
 *  planner adapter. */
const fakePlanner = {
  name: 'planner',
  fn: async (scope: PatternScope<Data>) => scope,
  config: { patternId: 'think' },
} as unknown as ConfiguredPattern<Data>

const frame: RunFrame = {
  transports: [
    {
      id: 'invented',
      ownsTool: (name) => name === 'read',
      listTools: async () => [],
      callTool: async () => ({ success: true, data: { row: 'INVENTED-RESULT' } }),
    },
  ],
}

describe('withBudget construction refusals (#1017 review)', () => {
  // MUTATION G1: delete the `withBudget requires a bounded loop route` throw.
  it('refuses withBudget on a route that is not a bounded loop', () => {
    const routes: Record<string, DecisionLoopRoute<Data>> = {
      think: { pattern: fakePlanner, description: 'x', withBudget: (n) => make('work', n) },
    }
    expect(() =>
      decisionLoop<Data>(routes, { decide, patternId: 'orchestrator', answer: 'Answer now' }),
    ).toThrow(/bounded loop route/)
  })

  // MUTATION G2: delete the `withBudget requires committed route history` throw.
  it.each([
    ['trackHistory off', { trackHistory: false as const }],
    ['commitStrategy last', { commitStrategy: 'last' as const }],
  ])('refuses withBudget when the loop would not commit its route history (%s)', (_name, cfg) => {
    const routes: Record<string, DecisionLoopRoute<Data>> = {
      work: { pattern: make(), description: 'x', withBudget: (n) => make('work', n) },
    }
    expect(() =>
      decisionLoop<Data>(routes, {
        decide,
        patternId: 'orchestrator',
        answer: 'Answer now',
        ...cfg,
      }),
    ).toThrow(/committed route history/)
  })

  // MUTATION G3: delete the `withBudget changed the route composition` throw.
  it('refuses a factory that rebuilds the route as a different composition, when the retry is built', async () => {
    const lying: DecisionLoopRoute<Data> = {
      pattern: make('work', 1),
      description: 'x',
      withBudget: (n) => make('work-CHANGED', n),
    }
    const loop = decisionLoop<Data>(
      { work: lying },
      { decide, patternId: 'orchestrator', answer: 'Answer now', maxIterations: 1 },
    )
    const r = await harness<Data>(loop)('Synthetic task', 'guard-session', undefined, undefined, {
      ...frame,
      hitl: { attended: true },
    })
    expect(r.status).toBe('paused')
    const [q] = readHitl(r.context).pending
    const done = await resumeHarness(r.serialized, [loop], { [q.requestId]: 'continue' }, { frame })
    expect(JSON.stringify(done)).toContain('changed the route composition')
  })
})
