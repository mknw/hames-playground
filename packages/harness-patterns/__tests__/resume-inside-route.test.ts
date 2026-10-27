/**
 * RESUME INSIDE A ROUTE (decision-loop-agent.md, slice 6).
 *
 * The owner's bar (2026-10-17): after an answer the run continues as if it had
 * not stopped, inside the route that paused, including whatever the route did
 * next. Each pin below is one of that section's, and names the source mutation
 * that turns it red; each mutation was run.
 *
 * The harness: a `decisionLoop` whose route is a real `simpleLoop` over a run-
 * scoped transport. `gated_write` asks the person (`askHuman`) and returns the
 * `held()` placeholder while the request waits; `plain_read` just answers. A
 * CONTROL run is the same composition whose `gated_write` returns the outcome
 * straight away, with no pause — the reference a resume is held to.
 */
import { describe, expect, it, vi } from 'vitest'
import { harness, resumeHarness, continueSession } from '../harness.server'
import { askHuman, held, HitlAnswerError, readHitl } from '../hitl.server'
import { followContinuation, refuseUnresumableGates } from '../pattern-capabilities'
import { resumableFingerprint, resumableStep, wrapperResumable } from '../resume.server'
import { WEB_ROSTER_INPUT, type WebRosterInput } from '../patterns/withPseudonymisedInputs.server'
import { actorCritic } from '../patterns/actorCritic.server'
import { decisionLoop, DECISION_LOOP_ANSWER } from '../patterns/decisionLoop.server'
import { planner, type PlannerData } from '../patterns/planner.server'
import { simpleLoop } from '../patterns/simpleLoop.server'
import { __clearReferenceCache, withReferences } from '../patterns/with-references.server'
import { withInjectionGuard } from '../patterns/withInjectionGuard.server'
import type { RunFrame } from '../run-frame.server'
import type { ToolTransport } from '../tool-transport.server'
import {
  LLMCallError,
  type ConfiguredPattern,
  type ControllerAction,
  type ControllerFn,
  type ControllerInput,
  type DecideFn,
  type EventView,
  type HitlOption,
  type HitlRequestEventData,
  type ToolResultEventData,
} from '../types'

type Data = Record<string, unknown> & { response?: string }

const OPTIONS: HitlOption[] = [
  { id: 'approve', label: 'Approve' },
  { id: 'reject', label: 'Reject', unattended: true },
]
const OUTCOME = 'The user chose: Approve.'

/** What was dispatched, in order. */
type Log = string[]

/** `gated_write` pauses (or, in a control run, answers with the outcome at
 *  once); `plain_read` answers with a fixed row. */
function transport(log: Log, control = false): ToolTransport {
  return {
    id: 'scripted',
    ownsTool: (name) => name === 'gated_write' || name === 'plain_read',
    callTool: async (name) => {
      log.push(name)
      if (name === 'plain_read') return { success: true, data: { rows: ['row-1'] } }
      if (control) return { success: true, data: OUTCOME }
      const outcome = await askHuman({
        kind: 'graph-write',
        question: 'Change the knowledge graph?',
        options: OPTIONS,
        defaultOption: 'reject',
      })
      return outcome.status === 'pending'
        ? { success: true, data: held(outcome) }
        : { success: true, data: `answered: ${outcome.choice}` }
    },
    listTools: async () => [],
  }
}

const act = (tool: string, args: unknown = {}, over: Partial<ControllerAction> = {}) => ({
  action: {
    reasoning: `use ${tool}`,
    tool_name: tool,
    tool_args: typeof args === 'string' ? args : JSON.stringify(args),
    status: `calling ${tool}`,
    is_final: tool === 'Return',
    ...over,
  } as ControllerAction,
})

/** A controller answering by turn from a script, recording every input. A
 *  script entry may also be a function of the input. */
function scripted(
  script: Array<
    ReturnType<typeof act> | 'unparseable' | ((i: ControllerInput) => ReturnType<typeof act>)
  >,
) {
  const inputs: ControllerInput[] = []
  const fn = vi.fn<ControllerFn>(async (input) => {
    inputs.push(structuredClone(input))
    const step = script[Math.min(input.turn, script.length - 1)]
    if (step === 'unparseable') {
      throw new LLMCallError(
        'BamlValidationError: Missing required field: tool_args',
        { functionName: 'LoopController', variables: {}, rawOutput: '{oops' },
        undefined,
        { recoverable: true },
      )
    }
    return typeof step === 'function' ? step(input) : step
  })
  return { fn, inputs }
}

/** A decide seam answering a scripted label per call, recording what it was
 *  offered each time. */
function scriptedDecide(script: string[]) {
  const offered: string[][] = []
  const fn = (async ({ spec }: { spec: { labels: readonly { id: string }[] } }) => {
    const ids = spec.labels.map((l) => l.id)
    offered.push(ids)
    const want = script[Math.min(offered.length - 1, script.length - 1)]
    return {
      probs: Object.fromEntries(ids.map((id) => [id, id === want ? 1 : 0])),
      method: 'jev',
      calibrated: false,
    }
  }) as unknown as DecideFn
  Object.assign(fn, { supportedTypes: ['choice'], limits: () => ({ contextWindow: 131_072 }) })
  return { fn, offered }
}

const loopOf = (controller: ControllerFn, cfg: Record<string, unknown> = {}) =>
  simpleLoop<Data>(controller, ['gated_write', 'plain_read'], {
    patternId: 'work',
    maxTurns: 6,
    ...cfg,
  })

function agent(
  routes: Record<string, ConfiguredPattern<Data>>,
  decide: DecideFn,
  cfg: Record<string, unknown> = {},
): ConfiguredPattern<Data>[] {
  return [
    decisionLoop<Data>(
      Object.fromEntries(
        Object.entries(routes).map(([name, pattern]) => [
          name,
          { pattern, description: `the ${name} route` },
        ]),
      ),
      {
        decide,
        answer: 'Answer now',
        patternId: 'orchestrator',
        gatedTools: ['gated_write'],
        ...cfg,
      },
    ),
  ]
}

const frameOf = (log: Log, control = false): RunFrame => ({ transports: [transport(log, control)] })

/** Run to the pause, then resume with Approve. */
async function pauseAndApprove(
  patterns: ConfiguredPattern<Data>[],
  log: Log,
  resolve = vi.fn(async () => undefined),
  serialized?: string,
) {
  const frame = frameOf(log)
  const paused = serialized
    ? await continueSession<Data>(serialized, patterns, 'change it', undefined, frame)
    : await harness<Data>(...patterns)('change it', 'sess-6', undefined, undefined, frame)
  expect(paused.status).toBe('paused')
  const [request] = readHitl(paused.context).pending
  const resumed = await resumeHarness<Data>(
    paused.serialized,
    patterns,
    { [request.requestId]: 'approve' },
    { frame, resolve },
  )
  return { paused, resumed, request }
}

const readThenWriteThenReturn = () =>
  scripted([act('plain_read'), act('gated_write'), act('Return', {}, { tool_args: 'done' })])

// ============================================================================

describe('slice 6 · after an answer the run continues inside the route', () => {
  // MUTATION: decide again on re-entry (drop the `resuming` branch in
  // decisionLoop's iteration) → a third decide call, and the route re-runs
  // from turn 0, dispatching `plain_read` a second time → red.
  it('no earlier tool is dispatched again, and no decide call is made for a finished or the paused iteration', async () => {
    const log: Log = []
    const { fn: controller } = readThenWriteThenReturn()
    const decide = scriptedDecide(['work', DECISION_LOOP_ANSWER])
    const { resumed, request } = await pauseAndApprove(
      agent({ work: loopOf(controller) }, decide.fn),
      log,
    )

    expect(resumed.status).not.toBe('error')
    expect(log).toEqual(['plain_read', 'gated_write'])
    // Iteration 1 decided 'work' before the pause; after it only 'answer'.
    expect(decide.offered).toHaveLength(2)
    // The controller ran turns 0 and 1 before the pause and turn 2 after it.
    expect(controller.mock.calls.map(([i]) => i.turn)).toEqual([0, 1, 2])
    // The request recorded the path it can be re-entered through.
    expect(request.continuation?.map((s) => [s.pattern, s.route, s.iteration])).toEqual([
      ['decisionLoop', 'work', 1],
      ['simpleLoop', undefined, undefined],
    ])
  })

  // MUTATION: rebuild an empty turn log (skip the replay loop in simpleLoop's
  // body) → the resumed controller is called at turn 0 with no turns → red.
  it("the resumed controller's input equals an uninterrupted control run's, given the same outcome", async () => {
    const control = readThenWriteThenReturn()
    await harness<Data>(
      ...agent({ work: loopOf(control.fn) }, scriptedDecide(['work', DECISION_LOOP_ANSWER]).fn),
    )('change it', 'sess-6', undefined, undefined, frameOf([], true))

    const resumedRun = readThenWriteThenReturn()
    await pauseAndApprove(
      agent({ work: loopOf(resumedRun.fn) }, scriptedDecide(['work', DECISION_LOOP_ANSWER]).fn),
      [],
    )

    // Not the pre-pause input: that one did not contain the held call.
    const controlAfter = control.inputs.find((i) => i.turn === 2)!
    const resumedAfter = resumedRun.inputs.find((i) => i.turn === 2)!
    expect(resumedAfter.turns).toHaveLength(2)
    expect(JSON.stringify(resumedAfter.turns)).toContain(OUTCOME)
    expect(resumedAfter).toEqual(controlAfter)
  })

  // MUTATION: drop the exclusion of the loop's own events from its view
  // (`visible(...)` in the prior-results window) → the resumed top-level loop
  // also sees its own pre-pause results as prior results → red.
  it('a resumed TOP-LEVEL loop reads the prior results an uninterrupted run would', async () => {
    const topLevel = (controller: ControllerFn) =>
      simpleLoop<Data>(controller, ['gated_write', 'plain_read'], {
        patternId: 'work',
        maxTurns: 6,
        viewConfig: { fromLast: false },
      })
    const control = readThenWriteThenReturn()
    await harness<Data>(topLevel(control.fn))(
      'change it',
      's',
      undefined,
      undefined,
      frameOf([], true),
    )

    const resumedRun = readThenWriteThenReturn()
    const frame = frameOf([])
    const patterns = [topLevel(resumedRun.fn)]
    const paused = await harness<Data>(...patterns)('change it', 's', undefined, undefined, frame)
    const [request] = readHitl(paused.context).pending
    await resumeHarness<Data>(
      paused.serialized,
      patterns,
      { [request.requestId]: 'approve' },
      { frame },
    )

    const controlAfter = control.inputs.find((i) => i.turn === 2)!
    const resumedAfter = resumedRun.inputs.find((i) => i.turn === 2)!
    expect(resumedAfter.priorResults).toEqual(controlAfter.priorResults)
    expect(resumedAfter.turns).toEqual(controlAfter.turns)
  })

  // MUTATION: record the unparseable round's recovery WITHOUT its `feedback`
  // (the live entry still uses it) → the rebuilt round-0 entry differs from
  // the control run's → red.
  it('a recovery, a read with a reference expansion and the pause: turn log, counters and annotations match the control run', async () => {
    // Turn A records two prior results the second turn can reference.
    const seedLoop = scripted([act('plain_read'), act('Return', {}, { tool_args: 'seeded' })])
    const seed = await harness<Data>(
      ...agent({ work: loopOf(seedLoop.fn) }, scriptedDecide(['work', DECISION_LOOP_ANSWER]).fn),
    )('read first', 'sess-6', undefined, undefined, frameOf([]))
    const blob = seed.serialized

    const expandFirst = (i: ControllerInput) =>
      act('plain_read', { from: `ref:${i.priorResults?.[0]?.ref_id}` })
    const script = () =>
      scripted([
        'unparseable',
        expandFirst,
        act('gated_write'),
        act('Return', {}, { tool_args: 'done' }),
      ])
    const cfg = { priorTurnCount: 2 }

    const control = script()
    await continueSession<Data>(
      blob,
      agent({ work: loopOf(control.fn, cfg) }, scriptedDecide(['work', DECISION_LOOP_ANSWER]).fn),
      'change it',
      undefined,
      frameOf([], true),
    )
    const resumedRun = script()
    await pauseAndApprove(
      agent(
        { work: loopOf(resumedRun.fn, cfg) },
        scriptedDecide(['work', DECISION_LOOP_ANSWER]).fn,
      ),
      [],
      undefined,
      blob,
    )

    const controlAfter = control.inputs.find((i) => i.turn === 3)!
    const resumedAfter = resumedRun.inputs.find((i) => i.turn === 3)!
    expect(resumedAfter.turns.map((t) => t.n)).toEqual([0, 1, 2])
    expect(resumedAfter.turns[1].expansions?.length).toBe(1)
    expect(resumedAfter.priorResults?.some((r) => r.expanded_in_turn === 1)).toBe(true)
    expect(resumedAfter).toEqual(controlAfter)
  })

  // MUTATION: drop `iteration` from the child's `pattern_enter` → the resume
  // cannot tell the two invocations apart and refuses the blob as corrupt →
  // the turn errors → red.
  it('a route that ran twice in the turn resumes its second invocation, not its first', async () => {
    const log: Log = []
    const controller = scripted([
      (i) =>
        i.planContext?.includes('first')
          ? act('gated_write')
          : act('Return', {}, { tool_args: 'first' }),
      act('Return', {}, { tool_args: 'second' }),
    ])
    const decide = scriptedDecide(['work', 'work', DECISION_LOOP_ANSWER])
    const { paused, resumed } = await pauseAndApprove(
      agent({ work: loopOf(controller.fn) }, decide.fn),
      log,
    )

    expect(resumed.status).not.toBe('error')
    const enters = paused.context.events.filter(
      (e) => e.type === 'pattern_enter' && (e.data as { route?: string }).route === 'work',
    )
    expect(enters.map((e) => (e.data as { iteration?: number }).iteration)).toEqual([1, 2])
    const exits = paused.context.events.filter(
      (e) => e.type === 'pattern_exit' && e.patternId === 'work',
    )
    expect(exits.map((e) => (e.data as { status: string }).status)).toEqual(['completed', 'paused'])
    // After the resume the controller continues the SECOND invocation: its one
    // turn is the held write, and the first invocation's Return is not in it.
    const after = controller.inputs.at(-1)!
    expect(after.turns.map((t) => t.tool_call?.tool)).toEqual(['gated_write'])
    expect(decide.offered).toHaveLength(3)
  })

  // MUTATION: reset the turn counter on replay (`firstTurn = 0`), or count the
  // iterations from 1 again → the loop runs past its bound → red.
  it('maxIterations and maxTurns count across the pause', async () => {
    const log: Log = []
    const controller = scripted([act('plain_read'), act('gated_write'), act('plain_read')])
    const decide = scriptedDecide(['work', 'work'])
    const { resumed } = await pauseAndApprove(
      agent({ work: loopOf(controller.fn, { maxTurns: 3 }) }, decide.fn, { maxIterations: 2 }),
      log,
    )

    // 3 turns in the first iteration (two before the pause, one after), 3 in
    // the second; 2 decisions in all.
    expect(controller.fn.mock.calls.map(([i]) => i.turn)).toEqual([0, 1, 2, 0, 1, 2])
    expect(decide.offered).toHaveLength(2)
    const exhausted = resumed.context.events.filter(
      (e) => e.type === 'error' && (e.data as { kind?: string }).kind === 'budget_exhausted',
    )
    // Each loop's own bound, then the decision loop's.
    expect(exhausted.map((e) => (e.data as { maxTurns?: number }).maxTurns)).toEqual([3, 3, 2])
  })

  // MUTATION: rebuild the records without `latestPlan` → the first decision
  // after the resume offers `think` again → red.
  it('a plan made before the pause keeps a guarded planner out of the first resumed decision', async () => {
    const planFn = vi.fn(async () => ({
      plan: { reasoning: 'r', plan: '1. read 2. write', n_steps: 2 },
      toolCount: 2,
    }))
    const decide = scriptedDecide(['think', 'work', DECISION_LOOP_ANSWER])
    const { resumed } = await pauseAndApprove(
      agent(
        {
          think: planner<PlannerData>(planFn as never, ['plain_read', 'gated_write'], {
            patternId: 'think',
          }) as unknown as ConfiguredPattern<Data>,
          work: loopOf(readThenWriteThenReturn().fn),
        },
        decide.fn,
      ),
      [],
    )

    expect(resumed.status).not.toBe('error')
    expect(planFn).toHaveBeenCalledTimes(1)
    expect(decide.offered).toHaveLength(3)
    expect(decide.offered[2]).not.toContain('think')
  })

  // MUTATION: leave the rebuilt records out of the repeat rule
  // (`stalledRoutes(records.slice(paused?.finished.length ?? 0))`) → the first
  // decision after the resume offers the stalled `idle` route again → red.
  it('a route stalled before the pause stays out of the first resumed decision (#809)', async () => {
    // Two records in a row with no tool call: `idle` is withheld from decision 3 on.
    const idle = simpleLoop<Data>(
      scripted([act('Return', {}, { tool_args: 'nothing to look up' })]).fn,
      ['plain_read'],
      { patternId: 'idle' },
    )
    const decide = scriptedDecide(['idle', 'idle', 'work', DECISION_LOOP_ANSWER])
    const { resumed } = await pauseAndApprove(
      agent({ idle, work: loopOf(readThenWriteThenReturn().fn) }, decide.fn),
      [],
    )

    expect(resumed.status).not.toBe('error')
    expect(decide.offered).toHaveLength(4)
    expect(decide.offered[2]).toEqual(['work', DECISION_LOOP_ANSWER])
    expect(decide.offered[3]).toEqual(['work', DECISION_LOOP_ANSWER])
  })

  // MUTATION: call the selector on re-entry (ignore the recorded
  // `reference_attached`) → it is called twice → red. The selection cache is
  // cleared between the pause and the resume, as a resume served by another
  // process would find it.
  it('the reference selector is not called on resume', async () => {
    const seedLoop = scripted([
      act('plain_read', {}, { additional_calls: [{ tool_name: 'plain_read', tool_args: '{}' }] }),
      act('Return', {}, { tool_args: 'seeded' }),
    ])
    const seed = await harness<Data>(
      ...agent({ work: loopOf(seedLoop.fn) }, scriptedDecide(['work', DECISION_LOOP_ANSWER]).fn),
    )('read first', 'sess-6', undefined, undefined, frameOf([]))

    const selector = vi.fn(async ({ candidates }: { candidates: { ref_id: string }[] }) => ({
      selected: [{ ref_id: candidates[0].ref_id, reason: 'first' }],
      reasoning: 'the first',
    }))
    const route = withReferences<Data>(loopOf(readThenWriteThenReturn().fn), {
      patternId: 'work',
      selector: selector as never,
      source: ['work'],
      viewConfig: { fromLast: false },
    })
    const patterns = agent({ work: route }, scriptedDecide(['work', DECISION_LOOP_ANSWER]).fn)
    const frame = frameOf([])
    const paused = await continueSession<Data>(
      seed.serialized,
      patterns,
      'change it',
      undefined,
      frame,
    )
    const [request] = readHitl(paused.context).pending
    expect(selector).toHaveBeenCalledTimes(1)
    __clearReferenceCache()
    const resumed = await resumeHarness<Data>(
      paused.serialized,
      patterns,
      { [request.requestId]: 'approve' },
      { frame },
    )

    expect(resumed.status).not.toBe('error')
    expect(selector).toHaveBeenCalledTimes(1)
  })
})

describe('slice 6 · the continuation is checked before any side effect', () => {
  // MUTATION: drop the continuation check in `checkResume` (skip
  // `followContinuation`) → the resume is accepted and `resolve` runs → red.
  it('a renamed paused route, with the top-level names kept, is chain-changed with zero resolve calls', async () => {
    const decide = scriptedDecide(['work', DECISION_LOOP_ANSWER])
    const frame = frameOf([])
    const paused = await harness<Data>(
      ...agent({ work: loopOf(readThenWriteThenReturn().fn) }, decide.fn),
    )('change it', 'sess-6', undefined, undefined, frame)
    const [request] = readHitl(paused.context).pending
    const renamed = agent({ work2: loopOf(readThenWriteThenReturn().fn) }, decide.fn)
    expect(renamed.map((p) => p.name)).toEqual(request.resumeAt?.names)

    const resolve = vi.fn(async () => undefined)
    const refusal = await resumeHarness<Data>(
      paused.serialized,
      renamed,
      { [request.requestId]: 'approve' },
      { frame, resolve },
    ).catch((e: unknown) => e)
    expect(refusal).toBeInstanceOf(HitlAnswerError)
    expect((refusal as HitlAnswerError).code).toBe('chain-changed')
    expect(resolve).not.toHaveBeenCalled()
  })

  // MUTATION: as above, drop the continuation check → a wrapper inserted
  // between the loop and its route is accepted → red.
  it('a pattern inserted on the path is chain-changed too', async () => {
    const decide = scriptedDecide(['work', DECISION_LOOP_ANSWER])
    const frame = frameOf([])
    const paused = await harness<Data>(
      ...agent({ work: loopOf(readThenWriteThenReturn().fn) }, decide.fn),
    )('change it', 'sess-6', undefined, undefined, frame)
    const [request] = readHitl(paused.context).pending
    const wrapped = agent(
      { work: withInjectionGuard({ tools: ['plain_read'] })(loopOf(readThenWriteThenReturn().fn)) },
      decide.fn,
    )
    const code = await resumeHarness<Data>(
      paused.serialized,
      wrapped,
      {
        [request.requestId]: 'approve',
      },
      { frame },
    ).then(
      () => 'accepted',
      (e: HitlAnswerError) => e.code,
    )
    expect(code).toBe('chain-changed')
  })
})

describe('slice 6 · followContinuation', () => {
  // MUTATION: drop the direct-child check → a capability whose `next` answers
  // a pattern that is not among the node's children is followed → red.
  it('refuses a path whose next step is not a direct child', () => {
    const leaf = loopOf(scripted([]).fn)
    const stray = loopOf(scripted([]).fn)
    const fingerprint = resumableFingerprint('wrapper', 'w')
    const wrapper: ConfiguredPattern<Data> = {
      ...leaf,
      name: 'wrapper(simpleLoop)',
      children: [leaf],
      capabilities: { resumable: { fingerprint, next: () => stray } },
    }
    const path = [
      { pattern: 'wrapper', fingerprint },
      { pattern: 'simpleLoop', fingerprint: leaf.capabilities!.resumable!.fingerprint },
    ]
    expect(followContinuation(wrapper, path)).toBe(false)
    expect(
      followContinuation(
        { ...wrapper, capabilities: { resumable: { fingerprint, next: () => leaf } } },
        path,
      ),
    ).toBe(true)
  })
})

describe('slice 6 · gated names only where a pause can be resumed', () => {
  // MUTATION: declare `resumable` on a simpleLoop that does not record its
  // rounds → construction accepts it → red.
  it('a loop with history recording off refuses a gated name at construction', () => {
    const quiet = loopOf(scripted([]).fn, { trackHistory: false })
    expect(() => agent({ work: quiet }, scriptedDecide([]).fn)).toThrow(/gated tool/)
    // Not gated: allowed.
    expect(() => agent({ work: quiet }, scriptedDecide([]).fn, { gatedTools: [] })).not.toThrow()
  })

  // MUTATION: let the walk accept any allowlist (drop the `stop` check) → a
  // gated name under actorCritic or a sandbox-shaped wrapper is accepted → red.
  it('a gated name under actorCritic or a non-resumable wrapper is refused at construction', () => {
    const critic = actorCritic<Data>(vi.fn() as never, vi.fn() as never, ['gated_write'], {
      patternId: 'office',
    })
    expect(() => agent({ office: critic }, scriptedDecide([]).fn)).toThrow(/actorCritic/)

    // The shape withSandbox has: it spreads the pattern it wraps, so it COPIES
    // that pattern's resumable capability, and adds its own tools.
    const inner = loopOf(scripted([]).fn)
    const sandboxed: ConfiguredPattern<Data> = {
      ...inner,
      name: 'withSandbox(simpleLoop)',
      children: [inner],
      capabilities: { ...inner.capabilities, tools: ['gated_write', 'sandbox_bash'] },
    }
    expect(() => agent({ office: sandboxed }, scriptedDecide([]).fn)).toThrow(/withSandbox/)
    // ...and from the root, by the entry points' walk, for a gate declared above.
    expect(() => refuseUnresumableGates([sandboxed], ['gated_write'])).toThrow(/withSandbox/)
  })

  // MUTATION: leave the batch check to the executor (drop the `gatedCall`
  // precheck) → `plain_read` is dispatched alongside the write → red.
  it.each(['parallel', 'off'] as const)(
    'a batch holding a gated name is refused before any call is dispatched (multiToolCalls %s)',
    async (mode) => {
      const log: Log = []
      const controller = scripted([
        act(
          'gated_write',
          {},
          { additional_calls: [{ tool_name: 'plain_read', tool_args: '{}' }] },
        ),
        act('Return', {}, { tool_args: 'done' }),
      ])
      const result = await harness<Data>(
        ...agent(
          { work: loopOf(controller.fn, { multiToolCalls: mode }) },
          scriptedDecide(['work', DECISION_LOOP_ANSWER]).fn,
        ),
      )('change it', 'sess-6', undefined, undefined, frameOf(log))

      expect(log).toEqual([])
      expect(result.status).not.toBe('paused')
      const fed = controller.inputs[1].turns[0].tool_result?.result ?? ''
      expect(fed).toContain('must be the only call of its turn')
      const results = result.context.events
        .filter((e) => e.type === 'tool_result' && e.patternId === 'work')
        .map((e) => e.data as ToolResultEventData)
      expect(results.every((r) => r.success === false)).toBe(true)
    },
  )
})

// ============================================================================
// Fix round 1 (#791 review): B1 and the pins for the surviving mutations
// ============================================================================

/** A resumable pass-through around a route that records what it was handed
 *  at each entry: the roster-only child input, the tool results its view
 *  offers and the earlier-conversation block (#785). */
function capture(
  inner: ConfiguredPattern<Data>,
  seen: { roster: unknown[]; view: string[]; conversation?: unknown }[],
) {
  const resumable = wrapperResumable('capture', inner)
  return {
    ...inner,
    name: `capture(${inner.name})`,
    children: [inner],
    capabilities: { ...inner.capabilities, pseudonymisedInputs: true as const, resumable },
    fn: (scope: Parameters<typeof inner.fn>[0], view: EventView) =>
      resumableStep('capture', resumable, () => {
        seen.push({
          roster: [
            ...((scope.data[WEB_ROSTER_INPUT] as WebRosterInput | undefined)?.payloads ?? []),
          ],
          view: view
            .fromAll()
            .ofType('tool_result')
            .get()
            .map((e) => (e.data as ToolResultEventData).tool),
          conversation: scope.data.conversation,
        })
        return inner.fn(scope, view)
      }),
  } satisfies ConfiguredPattern<Data>
}

describe('fix round 1 · a recorded continuation is always bound', () => {
  // B1. MUTATION: revert the guard to `ownResumable(top)` only → the resume is
  // accepted, `resolve` runs and the loop re-runs from iteration 1 → red.
  it('a composition whose top-level pattern stopped being resumable is chain-changed before resolve', async () => {
    const frame = frameOf([])
    const mk = (commitStrategy: string) =>
      agent(
        {
          work: loopOf(
            scripted([act('plain_read'), act('gated_write'), act('Return', {}, { tool_args: 'd' })])
              .fn,
          ),
        },
        scriptedDecide(['work', DECISION_LOOP_ANSWER]).fn,
        { commitStrategy, gatedTools: [] },
      )
    const p1 = await harness<Data>(...mk('always'))('q', 's', undefined, undefined, frame)
    const [r1] = readHitl(p1.context).pending
    expect(r1.continuation).toBeDefined()
    const resolve = vi.fn(async () => undefined)
    const out = await resumeHarness<Data>(
      p1.serialized,
      mk('last'),
      { [r1.requestId]: 'approve' },
      { frame, resolve },
    ).then(
      (r) => `resumed:${r.status}`,
      (e: HitlAnswerError) => `refused:${e.code}`,
    )
    expect(out).toBe('refused:chain-changed')
    expect(resolve).not.toHaveBeenCalled()
  })

  // X2 and X3. MUTATIONS: drop `tools` from simpleLoop's fingerprint, or
  // `gatedTools` from decisionLoop's → the changed composition is accepted → red.
  it.each([
    [
      'the route loop allowlist',
      () =>
        agent(
          {
            work: simpleLoop<Data>(
              readThenWriteThenReturn().fn,
              ['gated_write', 'plain_read', 'x'],
              {
                patternId: 'work',
                maxTurns: 6,
              },
            ),
          },
          scriptedDecide(['work', DECISION_LOOP_ANSWER]).fn,
        ),
    ],
    [
      'the gated-name list',
      () =>
        agent(
          { work: loopOf(readThenWriteThenReturn().fn) },
          scriptedDecide(['work', DECISION_LOOP_ANSWER]).fn,
          { gatedTools: ['gated_write', 'another'] },
        ),
    ],
  ])('a change to %s between the pause and the resume is chain-changed', async (_what, changed) => {
    const frame = frameOf([])
    const paused = await harness<Data>(
      ...agent(
        { work: loopOf(readThenWriteThenReturn().fn) },
        scriptedDecide(['work', DECISION_LOOP_ANSWER]).fn,
      ),
    )('q', 's', undefined, undefined, frame)
    const [request] = readHitl(paused.context).pending
    const resolve = vi.fn(async () => undefined)
    const code = await resumeHarness<Data>(
      paused.serialized,
      changed(),
      { [request.requestId]: 'approve' },
      { frame, resolve },
    ).then(
      () => 'accepted',
      (e: HitlAnswerError) => e.code,
    )
    expect(code).toBe('chain-changed')
    expect(resolve).not.toHaveBeenCalled()
  })

  // X4. MUTATION: drop `!pending.every(samePath)` → two requests recorded on
  // different paths are resumed down the first one → red.
  it('two waiting requests on different paths are chain-changed', async () => {
    const frame = frameOf([])
    const patterns = agent(
      { work: loopOf(readThenWriteThenReturn().fn) },
      scriptedDecide(['work', DECISION_LOOP_ANSWER]).fn,
    )
    const paused = await harness<Data>(...patterns)('q', 's', undefined, undefined, frame)
    const ctx = JSON.parse(paused.serialized) as { events: { type: string; data: unknown }[] }
    const original = ctx.events.find((e) => e.type === 'hitl_request')!
    const data = original.data as HitlRequestEventData
    const other = '00000000-0000-4000-8000-0000000000aa'
    ctx.events.push({
      ...original,
      data: {
        ...data,
        requestId: other,
        key: `${data.key}-other`,
        continuation: data.continuation!.map((seg, i) =>
          i === 0 ? { ...seg, iteration: 2 } : seg,
        ),
      },
    })
    const resolve = vi.fn(async () => undefined)
    const code = await resumeHarness<Data>(
      JSON.stringify(ctx),
      patterns,
      { [data.requestId]: 'approve', [other]: 'approve' },
      { frame, resolve },
    ).then(
      () => 'accepted',
      (e: HitlAnswerError) => e.code,
    )
    expect(code).toBe('chain-changed')
    expect(resolve).not.toHaveBeenCalled()
  })
})

describe('fix round 1 · what the rebuild restores', () => {
  const twoRoutes = (seen: { roster: unknown[]; view: string[] }[], control = false) => ({
    patterns: agent(
      {
        other: simpleLoop<Data>(
          scripted([act('plain_read'), act('Return', {}, { tool_args: 'other done' })]).fn,
          ['plain_read'],
          { patternId: 'other', maxTurns: 3 },
        ),
        work: capture(loopOf(readThenWriteThenReturn().fn), seen),
      },
      scriptedDecide(['other', 'work', DECISION_LOOP_ANSWER]).fn,
    ),
    frame: frameOf([], control),
  })

  // X1 (SD-9). MUTATION: drop the finished iterations' `rosterPayloads.push`
  // in the replay → the resumed route's roster input misses the results of the
  // iteration that ran before the pause → red.
  it("a resumed route's roster input equals the control run's", async () => {
    const control: { roster: unknown[]; view: string[] }[] = []
    const c = twoRoutes(control, true)
    await harness<Data>(...c.patterns)('q', 's', undefined, undefined, c.frame)

    const resumed: { roster: unknown[]; view: string[] }[] = []
    const r = twoRoutes(resumed)
    const paused = await harness<Data>(...r.patterns)('q', 's', undefined, undefined, r.frame)
    const [request] = readHitl(paused.context).pending
    await resumeHarness<Data>(
      paused.serialized,
      r.patterns,
      { [request.requestId]: 'approve' },
      {
        frame: r.frame,
      },
    )

    // The records themselves, without the ids each run generates.
    const shape = (roster: unknown[]) =>
      (roster as ToolResultEventData[]).map(({ tool, result, success }) => ({
        tool,
        result,
        success,
      }))
    expect(control).toHaveLength(1)
    expect(resumed).toHaveLength(2)
    expect(shape(control[0].roster)).toEqual([
      { tool: 'plain_read', result: { rows: ['row-1'] }, success: true },
    ])
    expect(shape(resumed[1].roster)).toEqual(shape(control[0].roster))
  })

  // X5. MUTATION: drop the paused brackets' exclusion from the resumed child's
  // view (`own`) → the child's view offers its own pre-pause results → red.
  it("a resumed route's view leaves out its own pre-pause events, as the control run's did", async () => {
    const control: { roster: unknown[]; view: string[] }[] = []
    const c = twoRoutes(control, true)
    await harness<Data>(...c.patterns)('q', 's', undefined, undefined, c.frame)

    const resumed: { roster: unknown[]; view: string[] }[] = []
    const r = twoRoutes(resumed)
    const paused = await harness<Data>(...r.patterns)('q', 's', undefined, undefined, r.frame)
    const [request] = readHitl(paused.context).pending
    await resumeHarness<Data>(
      paused.serialized,
      r.patterns,
      { [request.requestId]: 'approve' },
      {
        frame: r.frame,
      },
    )

    expect(resumed[1].view).toEqual(control[0].view)
    expect(resumed[1].view).not.toContain('gated_write')
  })

  // X6. MUTATION: skip restoring `decisions.next_step` → a loop that hits its
  // bound right after the resumed iteration carries no decision → red.
  it('the latest decision is restored when the loop ends straight after the resumed iteration', async () => {
    const control = await harness<Data>(
      ...agent({ work: loopOf(readThenWriteThenReturn().fn) }, scriptedDecide(['work']).fn, {
        maxIterations: 1,
      }),
    )('q', 's', undefined, undefined, frameOf([], true))
    const { resumed } = await pauseAndApprove(
      agent({ work: loopOf(readThenWriteThenReturn().fn) }, scriptedDecide(['work']).fn, {
        maxIterations: 1,
      }),
      [],
    )
    const decision = (d: Data) =>
      (d.decisions as Record<string, { label: string; probs: unknown }> | undefined)?.next_step
    expect(decision(resumed.data)).toMatchObject({ label: 'work' })
    expect(decision(resumed.data)?.probs).toEqual(decision(control.data)?.probs)
  })

  // Merging #785 into slice 6. MUTATIONS: drop the conversation read on the
  // resumed iteration → its child gets no earlier-conversation block → red.
  // Drop the `resumedIds` exclusion from `earlierPayloads` → the resumed
  // child's roster also holds its own pre-pause results, which the control
  // run's never did → red (and X1 above).
  it('a resumed route in a later turn gets the earlier conversation and roster the control run did', async () => {
    const routes = (seen: { roster: unknown[]; view: string[]; conversation?: unknown }[]) =>
      agent(
        { work: capture(loopOf(readThenWriteThenReturn().fn), seen) },
        scriptedDecide([DECISION_LOOP_ANSWER, 'work', DECISION_LOOP_ANSWER]).fn,
      )
    const firstTurn = async (patterns: ConfiguredPattern<Data>[], control: boolean) =>
      (
        await harness<Data>(...patterns)(
          'the first question',
          's',
          undefined,
          undefined,
          frameOf([], control),
        )
      ).serialized

    const control: { roster: unknown[]; view: string[]; conversation?: unknown }[] = []
    const c = routes(control)
    await continueSession<Data>(
      await firstTurn(c, true),
      c,
      'change it',
      undefined,
      frameOf([], true),
    )

    const resumed: { roster: unknown[]; view: string[]; conversation?: unknown }[] = []
    const r = routes(resumed)
    await pauseAndApprove(r, [], undefined, await firstTurn(r, false))

    expect(control).toHaveLength(1)
    expect(resumed).toHaveLength(2)
    expect(control[0].conversation).toContain('the first question')
    expect(resumed[1].conversation).toEqual(control[0].conversation)
    const tools = (roster: unknown[]) => (roster as ToolResultEventData[]).map((d) => d.tool)
    expect(tools(resumed[1].roster)).toEqual(tools(control[0].roster))
  })

  // N3. MUTATION: declare `resumable` on withReferences whatever it records →
  // one that does not record its selection reads as resumable → red.
  it('withReferences is resumable only while it records its selection', () => {
    const inner = loopOf(scripted([]).fn)
    const recording = withReferences<Data>(inner, { patternId: 'work', selector: vi.fn() as never })
    const quiet = withReferences<Data>(inner, {
      patternId: 'work',
      selector: vi.fn() as never,
      trackHistory: false,
    })
    expect(recording.capabilities?.resumable).toBeDefined()
    expect(quiet.capabilities?.resumable).toBeUndefined()
  })
})
