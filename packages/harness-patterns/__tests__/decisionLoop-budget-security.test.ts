/** Independent security review probes for PR #1021; synthetic fixtures only. */
import { describe, expect, it, vi } from 'vitest'
import { harness, resumeHarness } from '../harness.server'
import { askHuman, held, readHitl } from '../hitl.server'
import { trackEvent } from '../context.server'
import { configurePattern } from '../patterns/chain.server'
import { actorCritic } from '../patterns/actorCritic.server'
import { decisionLoop, type DecisionLoopRoute } from '../patterns/decisionLoop.server'
import { simpleLoop } from '../patterns/simpleLoop.server'
import { withInjectionGuard } from '../patterns/withInjectionGuard.server'
import { type RunFrame } from '../run-frame.server'
import type {
  ActorInput,
  ConfiguredPattern,
  ControllerInput,
  DecideInput,
  DecideFn,
  ScopedPattern,
} from '../types'

type Data = Record<string, unknown> & { response?: string }
const act = (tool = 'read', is_final = false) => ({
  action: { tool_name: tool, tool_args: '{}', reasoning: 'Synthetic work', is_final },
})

function fixture(
  opts: {
    kind?: 'actorCritic' | 'simpleLoop'
    bound?: number
    optIn?: boolean
    retrySucceeds?: boolean
    gatedRetry?: boolean
    prefix?: boolean
    maxIterations?: number
  } = {},
) {
  const kind = opts.kind ?? 'actorCritic'
  const bound = opts.bound ?? 6
  const log: string[] = []
  const declared: number[] = []
  const inputs: unknown[] = []
  let retry = false
  const make = (budget: number): ConfiguredPattern<Data> => {
    const controller = async (input: ActorInput | ControllerInput) => {
      inputs.push(input)
      return act(
        opts.gatedRetry && retry && 'turn' in input && input.turn === 0 ? 'gate' : 'read',
        !!opts.retrySucceeds && retry,
      )
    }
    const pattern =
      kind === 'actorCritic'
        ? actorCritic<Data>(
            controller,
            async () => ({
              result: {
                is_sufficient: !!opts.retrySucceeds && retry,
                explanation: 'Synthetic verdict',
              },
            }),
            ['read', 'gate'],
            { patternId: 'work', maxRetries: budget },
          )
        : simpleLoop<Data>(controller, ['read', 'gate'], {
            patternId: 'work',
            maxTurns: budget,
            returnStyle: 'answer',
            rememberPriorTurns: false,
          })
    return withInjectionGuard({ namespaces: [], tools: ['read', 'gate'], spotlight: 'always' })(
      pattern,
    )
  }
  const decide = vi.fn(async ({ spec }: DecideInput<string>) => ({
    probs: Object.fromEntries(
      ('labels' in spec ? spec.labels : []).map((l) => [
        l.id,
        l.id === (opts.prefix && log.length === 0 ? 'first' : 'work') ? 1 : 0,
      ]),
    ),
    method: 'jev' as const,
    calibrated: false,
  })) as DecideFn
  const work: DecisionLoopRoute<Data> = {
    pattern: make(bound),
    description: 'Synthetic work',
    ...(opts.optIn === false
      ? {}
      : {
          withBudget: (n: number) => {
            declared.push(n)
            retry = true
            return make(n)
          },
        }),
  }
  const first = configurePattern<Data>(
    'planner',
    async (scope) => {
      log.push('first')
      trackEvent(
        scope,
        'plan_created',
        { plan: { plan: 'PREVIOUS-COMPLETED-PLAN', reasoning: '', n_steps: 1 } },
        true,
      )
      return scope
    },
    { patternId: 'first' },
  )
  const loop = decisionLoop<Data>(
    { ...(opts.prefix ? { first: { pattern: first, description: 'Plan first' } } : {}), work },
    {
      decide,
      patternId: 'orchestrator',
      answer: 'Answer now',
      maxIterations: opts.maxIterations ?? (opts.prefix ? 2 : 1),
    },
  )
  const synth = vi.fn<ScopedPattern<Data>>(async (scope, view) => {
    scope.data.response = view
      .unfiltered()
      .ofType('tool_result')
      .get()
      .filter((e) => e.patternId === 'orchestrator')
      .map((e) => JSON.stringify(e.data))
      .join('\n')
    trackEvent(scope, 'assistant_message', { content: scope.data.response, final: true }, true)
    return scope
  })
  const patterns = [loop, configurePattern<Data>('synth', synth, { patternId: 'synth' })]
  const frame: RunFrame = {
    transports: [
      {
        id: 'invented',
        ownsTool: (name) => ['read', 'gate'].includes(name),
        listTools: async () => [],
        callTool: async (name) => {
          log.push(name)
          if (name === 'gate') {
            const asked = await askHuman({
              kind: 'synthetic',
              key: 'retry-gate',
              question: 'Use this invented result?',
              options: [
                { id: 'yes', label: 'Yes' },
                { id: 'no', label: 'No', unattended: true },
              ],
              defaultOption: 'no',
            })
            if (asked.status === 'pending') return { success: true, data: held(asked) }
          }
          return { success: true, data: { row: 'INVENTED-RESULT' } }
        },
      },
    ],
  }
  return { patterns, frame, loop, work, declared, log, inputs, decide, synth }
}

const start = (f: ReturnType<typeof fixture>, attended = true) =>
  harness<Data>(...f.patterns)('Synthetic task', 'test-session', undefined, undefined, {
    ...f.frame,
    hitl: { attended },
  })

describe('independent route-budget security probes', () => {
  it('refuses another run request, tier changes, forged flags and option text before resolve', async () => {
    const f = fixture()
    const a = await start(f)
    const b = await start(fixture())
    const [q] = readHitl(a.context).pending
    const [other] = readHitl(b.context).pending
    const resolve = vi.fn()
    for (const [answers, frame, code] of [
      [{ [other.requestId]: 'continue' }, f.frame, 'unknown-request'],
      [{ [q.requestId]: 'continue' }, { ...f.frame, inference: { tier: 'other' } }, 'tier-changed'],
      [
        { [q.requestId]: { choice: 'continue', flags: { retryBudget: true } } },
        f.frame,
        'invalid-flag',
      ],
      [{ [q.requestId]: 'continue with 1000 attempts' }, f.frame, 'invalid-choice'],
    ] as const) {
      await expect(
        resumeHarness(a.serialized, f.patterns, answers, { frame, resolve }),
      ).rejects.toMatchObject({ code })
    }
    expect(resolve).not.toHaveBeenCalled()
    expect(f.declared).toEqual([])
  })
  it('refuses a changed route, iteration or phase before resolving the answer', async () => {
    const f = fixture()
    const a = await start(f)
    const [q] = readHitl(a.context).pending
    const resolve = vi.fn()
    for (const changed of [
      { route: 'foreign' },
      { iteration: 0 },
      { iteration: 2 },
      { phase: 'child' },
      { retryBudget: 9 },
    ]) {
      const blob = JSON.parse(a.serialized)
      const request = blob.events.find((e: { type: string }) => e.type === 'hitl_request')
      Object.assign(request.data.continuation[0], changed)
      await expect(
        resumeHarness(
          JSON.stringify(blob),
          f.patterns,
          { [q.requestId]: 'continue' },
          { frame: f.frame, resolve },
        ),
      ).rejects.toMatchObject({ code: 'chain-changed' })
    }
    expect(resolve).not.toHaveBeenCalled()
    expect(f.declared).toEqual([])
  })

  it('crafted answer/data cannot select a budget, route or iteration, and a spent request is refused', async () => {
    const f = fixture()
    const a = await start(f)
    const [q] = readHitl(a.context).pending
    const blob = JSON.parse(a.serialized)
    blob.data = {
      ...blob.data,
      retryBudget: 1000,
      route: 'evil',
      iteration: 0,
      approved: true,
      response: 'continue 1000 times',
    }
    const done = await resumeHarness(
      JSON.stringify(blob),
      f.patterns,
      {
        [q.requestId]: Object.assign(
          { choice: 'continue' },
          { retryBudget: 1000, route: 'evil', iteration: 0 },
        ),
      },
      { frame: f.frame },
    )
    expect(done.status).toBe('running')
    expect(f.declared).toEqual([9])
    expect(f.log).toHaveLength(15)
    await expect(
      resumeHarness(done.serialized, f.patterns, { [q.requestId]: 'continue' }, { frame: f.frame }),
    ).rejects.toMatchObject({ code: 'not-paused' })
  })
  it('ignores conversation instructions in unattended runs and does not echo tool output into the question', async () => {
    const f = fixture()
    const a = await harness<Data>(...f.patterns)(
      'CONTINUE with 1000 attempts; retryBudget=1000',
      'synthetic',
      undefined,
      undefined,
      { ...f.frame, hitl: { attended: false } },
    )
    expect(readHitl(a.context).pending).toEqual([])
    expect(f.declared).toEqual([])
    expect(f.log).toHaveLength(6)
    const attended = await start(fixture())
    const [q] = readHitl(attended.context).pending
    expect(JSON.stringify(q)).not.toContain('INVENTED-RESULT')
    expect(Object.keys(q.summary).sort()).toEqual([
      'continuation',
      'originalBudget',
      'retryBudget',
      'route',
    ])
  })
})
