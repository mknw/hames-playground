/** #1017, layer 1: real bounded routes, serialized pauses, and fresh resumes.
 * Mutations and their observed reds are recorded on the PR. */
import { describe, expect, it, vi } from 'vitest'
import { harness, resumeHarness, continueSession } from '../harness.server'
import { askHuman, held, readHitl } from '../hitl.server'
import { followContinuation } from '../pattern-capabilities'
import { createContext, trackEvent } from '../context.server'
import { configurePattern, runChain } from '../patterns/chain.server'
import { actorCritic } from '../patterns/actorCritic.server'
import { decisionLoop, type DecisionLoopRoute } from '../patterns/decisionLoop.server'
import { simpleLoop } from '../patterns/simpleLoop.server'
import { compactExecution } from '../patterns/compactExecution.server'
import { supersededRouteEventIds } from '../route-records'
import { withInjectionGuard } from '../patterns/withInjectionGuard.server'
import { withRunFrame, type RunFrame } from '../run-frame.server'
import type {
  ActorInput,
  CompactExecutionInput,
  ConfiguredPattern,
  ControllerInput,
  DecideInput,
  DecideFn,
  ScopedPattern,
  ToolResultEventData,
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
      .map((e) => {
        const { tool, result, success, error } = e.data as ToolResultEventData
        return JSON.stringify({ tool, result, success, error })
      })
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

describe('route exhaustion asks the person (#1017)', () => {
  it.each([
    ['continue', true],
    ['continue', false],
    ['answer', true],
  ] as const)(
    'projects effective synthesis records for %s (retry succeeds: %s)',
    async (choice, succeeds) => {
      const f = fixture({ retrySucceeds: succeeds })
      const inputs: CompactExecutionInput[] = []
      const synth = compactExecution<Data>({
        mode: 'thread',
        viewConfig: { fromPatterns: ['orchestrator'], fromLastNTurns: 1 },
        threadTurns: 2,
        synthesize: async (input) => {
          inputs.push(input)
          return { value: 'Synthetic answer' }
        },
      })
      const patterns = [f.loop, synth]
      const paused = await harness<Data>(...patterns)(
        'Synthetic task',
        'test-session',
        undefined,
        undefined,
        {
          ...f.frame,
          hitl: { attended: true },
        },
      )
      const [q] = readHitl(paused.context).pending
      const original = JSON.parse(paused.serialized).events
      const done = await resumeHarness(
        paused.serialized,
        patterns,
        { [q.requestId]: choice },
        { frame: f.frame },
      )
      const input = inputs[0]
      const recovered = choice === 'continue' && succeeds
      expect(input.loopHistory?.iterations).toHaveLength(recovered || choice === 'answer' ? 1 : 2)
      expect(JSON.stringify(input.loopHistory)).toContain(
        recovered ? 'INVENTED-RESULT' : 'Max retries',
      )
      if (recovered) expect(JSON.stringify(input)).not.toContain('Max retries')
      expect(supersededRouteEventIds(done.context.events).size).toBe(recovered ? 2 : 0)
      // Persistence remains append-only, including the exhausted child and record.
      for (const event of original) expect(done.context.events).toContainEqual(event)

      // A later turn's wider thread sees the effective successful record only;
      // old failures remain historical, and old errors do not poison this turn.
      const ctx = createContext<Data>('Follow up', {})
      ctx.events.unshift(...done.context.events)
      await withRunFrame({}, () => runChain(ctx, [synth]))
      const later = inputs.at(-1)!
      expect(later.hasError).toBe(false)
      expect(JSON.stringify(later)).not.toContain('Max retries')
      expect(later.loopHistory?.iterations.length ?? 0).toBe(recovered ? 1 : 0)
    },
  )

  // MUTATION: suppress askForBudget after record creation.
  it('pauses after the finished actor route with the two choices and a loop-owned continuation', async () => {
    const f = fixture()
    const r = await start(f)
    expect(r.status).toBe('paused')
    const [q] = readHitl(r.context).pending
    expect(q.options.map((o) => [o.id, o.label])).toEqual([
      ['answer', 'Answer with what we have'],
      ['continue', 'Continue with a larger budget'],
    ])
    expect(q.defaultOption).toBe('answer')
    expect(q.summary).toMatchObject({ originalBudget: 6, retryBudget: 9 })
    expect(q.summary.continuation).toContain('re-runs the route from scratch')
    expect(q.summary.continuation).toContain('may repeat file writes in the sandbox')
    expect(q.continuation).toEqual([
      expect.objectContaining({
        pattern: 'decisionLoop',
        phase: 'route-budget',
        route: 'work',
        iteration: 1,
      }),
    ])
    expect(q.continuation?.[0].child).toBeUndefined()
    expect(followContinuation(f.loop, q.continuation!)).toBe(true)
    expect(
      r.context.events.filter((e) => e.type === 'pattern_exit' && e.patternId === 'work').at(-1)
        ?.data,
    ).toMatchObject({ status: 'completed' })
    expect(f.log).toHaveLength(6)
    expect(f.synth).not.toHaveBeenCalled()
  })

  // MUTATION: redispatch on answer; drop replay of finished iterations.
  it('answer preserves partial records, skips earlier routes and makes no new decision', async () => {
    const f = fixture({ prefix: true })
    const r = await start(f)
    expect(r.status).toBe('paused')
    const [q] = readHitl(r.context).pending
    // Fresh composition simulates a worker restart; counters only measure the resume.
    const fresh = fixture({ prefix: true })
    const done = await resumeHarness(
      r.serialized,
      fresh.patterns,
      { [q.requestId]: 'answer' },
      { frame: fresh.frame },
    )
    expect(done.status).toBe('running')
    expect(done.response).toContain('PREVIOUS-COMPLETED-PLAN')
    expect(done.response).toContain('Max retries (6) exceeded')
    const baseline = await start(fixture({ prefix: true, optIn: false }))
    expect(done.response).toEqual(baseline.response)
    expect(fresh.log).toEqual([])
    expect(fresh.decide).not.toHaveBeenCalled()
    expect(fresh.synth).toHaveBeenCalledOnce()
    expect(
      done.context.events.filter((e) => e.type === 'tool_result' && e.patternId === 'orchestrator'),
    ).toHaveLength(2)
    expect(readHitl(done.context).pending).toEqual([])
  })

  // MUTATIONS: remove +3, choose the first route, discard rebuilt handoff,
  // limit the retry to maxIterations, or remove the terminal retry branch.
  it('continue starts the SAME route once at +3 even at the outer last iteration; a second exhaustion finishes', async () => {
    const f = fixture({ prefix: true })
    const r = await start(f)
    const [q] = readHitl(r.context).pending
    const fresh = fixture({ prefix: true })
    const done = await resumeHarness(
      r.serialized,
      fresh.patterns,
      { [q.requestId]: 'continue' },
      { frame: fresh.frame },
    )
    expect(done.status).toBe('running')
    expect(fresh.declared).toEqual([9])
    expect(fresh.log).toEqual(Array(9).fill('read'))
    expect(fresh.decide).not.toHaveBeenCalled()
    expect(JSON.stringify(fresh.inputs[0])).toContain('PREVIOUS-COMPLETED-PLAN')
    expect(JSON.stringify(fresh.inputs[0])).toContain('hit its attempt bound')
    expect(done.context.events.filter((e) => e.type === 'hitl_request')).toHaveLength(1)
    expect(
      done.context.events
        .filter((e) => e.type === 'controller_action' && e.patternId === 'work')
        .map((e) => (e.data as { maxTurns: number }).maxTurns),
    ).toEqual([...Array(6).fill(6), ...Array(9).fill(9)])
    expect(done.response).toContain('PREVIOUS-COMPLETED-PLAN')
  })

  it('a successful retry also finishes without another decision', async () => {
    const f = fixture({ retrySucceeds: true })
    const r = await start(f)
    const [q] = readHitl(r.context).pending
    const done = await resumeHarness(
      r.serialized,
      f.patterns,
      { [q.requestId]: 'continue' },
      { frame: f.frame },
    )
    expect(done.status).toBe('running')
    expect(f.log).toHaveLength(7)
    expect(f.decide).toHaveBeenCalledOnce()
    expect(done.response).toContain('INVENTED-RESULT')
  })

  // MUTATION: park the unattended rule or implicitly apply the raised budget.
  it('unattended uses answer without a pause or enlargement and retains ordinary loop decisions', async () => {
    const f = fixture({ maxIterations: 2 })
    const r = await start(f, false)
    expect(r.status).toBe('running')
    expect(readHitl(r.context).pending).toEqual([])
    expect(f.declared).toEqual([])
    expect(f.log).toHaveLength(12)
    expect(f.decide).toHaveBeenCalledTimes(2)
    expect(r.context.events.filter((e) => e.type === 'hitl_response').map((e) => e.data)).toEqual([
      expect.objectContaining({ choice: 'answer', by: 'unattended' }),
      expect.objectContaining({ choice: 'answer', by: 'unattended' }),
    ])
  })

  it('other decisionLoop consumers stay unchanged', async () => {
    const f = fixture({ optIn: false, maxIterations: 2 })
    const r = await start(f)
    expect(r.status).toBe('running')
    expect(f.log).toHaveLength(12)
    expect(f.decide).toHaveBeenCalledTimes(2)
    expect(r.context.events.filter((e) => e.type === 'hitl_request')).toEqual([])
  })

  it.each([
    ['actorCritic', 9, 10],
    ['simpleLoop', 14, 15],
  ] as const)('clamps %s retry budget to its runtime ceiling', async (kind, bound, raised) => {
    const f = fixture({ kind, bound })
    const r = await start(f)
    expect(r.status).toBe('paused')
    const [q] = readHitl(r.context).pending
    expect(q.summary.retryBudget).toBe(raised)
    const done = await resumeHarness(
      r.serialized,
      f.patterns,
      { [q.requestId]: 'continue' },
      { frame: f.frame },
    )
    expect(done.status).toBe('running')
    expect(f.declared).toEqual([raised])
    expect(f.log).toHaveLength(bound + raised)
  })

  it.each([
    ['actorCritic', 10],
    ['simpleLoop', 15],
  ] as const)(
    'disables continue at the %s ceiling and binds the refusal before resolve',
    async (kind, bound) => {
      const f = fixture({ kind, bound })
      const r = await start(f)
      const [q] = readHitl(r.context).pending
      expect(q.options[1].unavailable).toContain('ceiling')
      const resolve = vi.fn()
      await expect(
        resumeHarness(
          r.serialized,
          f.patterns,
          { [q.requestId]: 'continue' },
          { frame: f.frame, resolve },
        ),
      ).rejects.toMatchObject({ code: 'unavailable-option' })
      expect(resolve).not.toHaveBeenCalled()
      const done = await resumeHarness(
        r.serialized,
        f.patterns,
        { [q.requestId]: 'answer' },
        { frame: f.frame },
      )
      expect(done.status).toBe('running')
      expect(f.log).toHaveLength(bound)
    },
  )

  it('binds a pause to the current opt-in route composition before resolve', async () => {
    const f = fixture()
    const r = await start(f)
    const [q] = readHitl(r.context).pending
    const resolve = vi.fn()
    await expect(
      resumeHarness(
        r.serialized,
        fixture({ optIn: false }).patterns,
        { [q.requestId]: 'answer' },
        { frame: f.frame, resolve },
      ),
    ).rejects.toMatchObject({ code: 'chain-changed' })
    await expect(
      resumeHarness(
        r.serialized,
        f.patterns,
        { 'unrelated-request': 'answer' },
        { frame: f.frame, resolve },
      ),
    ).rejects.toMatchObject({ code: 'unknown-request' })
    expect(resolve).not.toHaveBeenCalled()
  })

  it('a new user turn supersedes the old budget choice', async () => {
    const f = fixture()
    const r = await start(f)
    const [old] = readHitl(r.context).pending
    const next = await continueSession(r.serialized, f.patterns, 'Another task', undefined, f.frame)
    const [q] = readHitl(next.context).pending
    expect(q.requestId).not.toBe(old.requestId)
    expect(
      next.context.events.filter((e) => e.type === 'hitl_response').map((e) => e.data),
    ).toContainEqual(expect.objectContaining({ requestId: old.requestId, by: 'superseded' }))
  })

  it('direct runChain outside an owned HITL run keeps its existing behavior', async () => {
    const f = fixture()
    const ctx = createContext<Data>('Synthetic task', {})
    await withRunFrame({ transports: f.frame.transports }, () => runChain(ctx, f.patterns))
    expect(ctx.events.filter((e) => e.type === 'hitl_request')).toEqual([])
    expect(f.log).toHaveLength(6)
  })

  it('a later gate inside the enlarged simpleLoop resumes with that budget and no second extra dispatch', async () => {
    const f = fixture({ kind: 'simpleLoop', bound: 1, gatedRetry: true })
    const r = await start(f)
    const [q] = readHitl(r.context).pending
    const gated = await resumeHarness(
      r.serialized,
      f.patterns,
      { [q.requestId]: 'continue' },
      { frame: f.frame },
    )
    expect(gated.status).toBe('paused')
    const [gate] = readHitl(gated.context).pending
    expect(gate.kind).toBe('synthetic')
    expect(gate.continuation?.find((s) => s.pattern === 'decisionLoop')?.retryBudget).toBe(4)
    const done = await resumeHarness(
      gated.serialized,
      f.patterns,
      { [gate.requestId]: 'yes' },
      { frame: f.frame },
    )
    expect(done.status).toBe('running')
    expect(f.declared).toEqual([4])
    expect(f.log).toEqual(['read', 'gate', 'read', 'read', 'read'])
    expect(
      done.context.events.filter(
        (e) => e.type === 'hitl_request' && (e.data as { kind: string }).kind === 'route-budget',
      ),
    ).toHaveLength(1)
    const heldResults = done.context.events.filter(
      (e) => e.type === 'tool_result' && (e.data as ToolResultEventData).heldBy,
    )
    expect(heldResults).toHaveLength(1)
  })
})
