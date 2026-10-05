/**
 * RAISE AND PAUSE (#433, slice S2).
 *
 * `askHuman(request)` asks a person to decide, from inside a run: a pattern
 * body or a tool executor, which holds no scope and no context — only the run
 * frame. It replays a decision this run already holds, applies the request's
 * unattended rule when nobody is there, or raises a `hitl_request` into the
 * frame's `hitl` slot and returns `pending`. A gated executor then returns
 * `held(outcome)` instead of the content, so a loop that ignored the stop check
 * would still never see what is being decided (the withholding is not
 * cooperative; the stop is). The loops and sequencers stop at their checks, and
 * the `runChain` that owns the slot commits the slot's buffer straight into the
 * context and pauses.
 *
 * Pins (spec §8):
 *
 *   H6    the same request in the same run asks once (replay, and dedupe).
 *   H7    default keys: content-addressed; a choice that is no longer an
 *         available option of the NEW request asks again (#472 amendment 2).
 *   H7b   the journal answers only the same kind, key and option set, and never
 *         from a proposal's answer [F8].
 *   H8    "Continue normally" is never picked unattended; every raise-time
 *         validation rule (with #472 amendment 1, ':' in a kind) has a pin.
 *   H9    a pause: `paused` is set, `pattern_exit` lands, nothing downstream runs;
 *         and `error` wins over a pending request [m2].
 *   H10   the stop check at every site.
 *   H11   `requestId` is a UUID v4.
 *   H12   `askHuman` with no owning chain throws.
 *   H13   the request is emitted live whatever `liveEvents` says.
 *   H13b  the slot survives `withInjectionGuard` and a sandbox-style amend, and
 *         a nested `runChain` leaves the owning run's buffer alone [F7]. The
 *         #477 review's two pins live here too: nothing reachable from the
 *         run frame can forge an answer or suppress the pause (F1), and two
 *         concurrent runs in one host frame keep their own requests (F2).
 *   H13c  a pattern that appends to `data` and then pauses does not double the
 *         entry when it is re-entered [F10].
 *
 * plus the S2 rows the spec names without an H number: `resumeAt` carries every
 * top-level name [m4], the `tier` stamp (C1), the `enterRun` default [F7], and
 * the two-loaded-copies pin the #472 review asked for (ruling 4).
 *
 * Every pin names the source mutation that turns it red; each one was run.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createContext } from '../context.server'
import { harness } from '../harness.server'
import {
  askHuman,
  held,
  hitlPending,
  HitlRequestError,
  readHitl,
  resolveUnattended,
} from '../hitl.server'
import { runBatch } from '../parallel-tools.server'
import { actorCritic } from '../patterns/actorCritic.server'
import { chain, configurePattern, runChain } from '../patterns/chain.server'
import { parallel } from '../patterns/parallel.server'
import { simpleLoop } from '../patterns/simpleLoop.server'
import { withInjectionGuard } from '../patterns/withInjectionGuard.server'
import {
  activeRunFrame,
  amendRunFrame,
  currentRunFrame,
  withRunFrame,
  type RunFrame,
} from '../run-frame.server'
import type { ToolTransport } from '../tool-transport.server'
import type { SimpleLoopData } from '../patterns/simpleLoop.server'
import type { ActorCriticData } from '../patterns/actorCritic.server'
import type {
  ActorFn,
  ConfiguredPattern,
  ContextEvent,
  ControllerAction,
  ControllerFn,
  HitlOption,
  HitlOutcome,
  HitlRequest,
  HitlRequestEventData,
  HitlResponseEventData,
  UnifiedContext,
} from '../types'

// ============================================================================
// Fixtures — synthetic throughout
// ============================================================================

const CONFIRM: HitlOption[] = [
  { id: 'approve', label: 'Approve' },
  { id: 'reject', label: 'Reject', unattended: true },
]

/** The provenance shape (#433 §7): four options, and the rule may never pick
 *  "Continue normally". */
const PROVENANCE: HitlOption[] = [
  { id: 'sanitize', label: 'Sanitize', unattended: true },
  {
    id: 'remove',
    label: 'Remove',
    unattended: true,
    flags: [{ id: 'markInjected', label: 'Mark as injected', default: false }],
  },
  { id: 'stop', label: 'Stop the run', unattended: true, stopsRun: true, tone: 'danger' },
  { id: 'continue', label: 'Continue normally', tone: 'caution' },
]

function confirm(over: Partial<HitlRequest> = {}): HitlRequest {
  return {
    kind: 'confirm',
    key: 'plan',
    question: 'Run this plan?',
    options: CONFIRM,
    defaultOption: 'reject',
    ...over,
  }
}

function provenance(over: Partial<HitlRequest> = {}): HitlRequest {
  return {
    kind: 'provenance',
    question: 'Use this external file?',
    options: PROVENANCE,
    defaultOption: 'sanitize',
    summary: { domain: 'fabrikam.example', filename: 'offer.docx', size: 48 },
    ...over,
  }
}

/** Pattern data: what `harness()` asks of it (a `response`), and open. */
type Data = { response?: string; [key: string]: unknown }

const ATTENDED: RunFrame = { hitl: { attended: true } }
const UNATTENDED: RunFrame = { hitl: { attended: false } }

/** A pattern that asks each request in turn and records what it was told. */
function gate(requests: HitlRequest[], outcomes: HitlOutcome[] = [], name = 'gate') {
  return configurePattern<Data>(name, async (scope) => {
    for (const r of requests) outcomes.push(await askHuman(r))
    return scope
  })
}

/** A pattern that records that it ran — the "downstream" every pause must skip. */
function marker(ran: string[], name: string) {
  return configurePattern<Data>(name, async (scope) => {
    ran.push(name)
    scope.data = { ...scope.data, response: `answered by ${name}` }
    return scope
  })
}

async function run(
  patterns: ConfiguredPattern<Data>[],
  frame: RunFrame = ATTENDED,
  ctx: UnifiedContext<Data> = createContext<Data>('write the report'),
) {
  await withRunFrame(frame, () => runChain(ctx, patterns))
  return ctx
}

const ofType = (ctx: Pick<UnifiedContext, 'events'>, type: string) =>
  ctx.events.filter((e) => e.type === type)
const requests = (ctx: Pick<UnifiedContext, 'events'>) =>
  ofType(ctx, 'hitl_request').map((e) => e.data as HitlRequestEventData)
const responses = (ctx: Pick<UnifiedContext, 'events'>) =>
  ofType(ctx, 'hitl_response').map((e) => e.data as HitlResponseEventData)

/** A blob from an earlier attempt of this run, holding a decided request — the
 *  shape a resume (S3) re-enters with. Plain objects, as a stored blob is. */
let seq = 0
function decided(
  request: Partial<HitlRequestEventData>,
  response: Partial<HitlResponseEventData> | null,
): UnifiedContext<Data> {
  const ctx = createContext<Data>('write the report')
  const data: HitlRequestEventData = {
    v: 1,
    requestId: 'req-earlier',
    runId: ctx.events[0].id!,
    key: 'confirm:plan',
    kind: 'confirm',
    question: 'Run this plan?',
    options: CONFIRM,
    defaultOption: 'reject',
    unattended: 'apply-default',
    summary: {},
    blocking: true,
    ...request,
  }
  const push = (type: ContextEvent['type'], d: unknown) =>
    ctx.events.push({ id: `ev-stored-${++seq}`, type, ts: seq, patternId: 'gate', data: d })
  push('hitl_request', data)
  if (response) {
    push('hitl_response', {
      v: 1,
      requestId: data.requestId,
      key: data.key,
      kind: data.kind,
      choice: 'approve',
      by: 'person',
      ...response,
    })
  }
  return ctx
}

afterEach(() => {
  vi.restoreAllMocks()
})

// ============================================================================
// H6 · replay: one run asks once
// ============================================================================

describe('H6 · the same request in the same run asks once', () => {
  // MUTATION: drop the journal lookup in askHuman → the second unattended ask
  // raises a second request/response pair → red.
  it('an unattended decision replays within the run instead of deciding again', async () => {
    const outcomes: HitlOutcome[] = []
    const ctx = await run([gate([provenance(), provenance()], outcomes)], UNATTENDED)

    expect(requests(ctx)).toHaveLength(1)
    expect(responses(ctx)).toHaveLength(1)
    expect(outcomes[1]).toEqual(outcomes[0])
    expect(outcomes[0]).toMatchObject({ status: 'answered', choice: 'sanitize', by: 'unattended' })
  })

  // MUTATION: drop the journal lookup → the re-entered gate raises again and
  // the run pauses a second time on the decision it already holds → red.
  it("a re-entered gate takes the earlier attempt's answer and does not pause", async () => {
    const ctx = decided({}, { choice: 'approve' })
    const outcomes: HitlOutcome[] = []
    await run([gate([confirm()], outcomes)], ATTENDED, ctx)

    expect(outcomes).toEqual([
      { status: 'answered', requestId: 'req-earlier', choice: 'approve', flags: {}, by: 'person' },
    ])
    expect(ctx.status).toBe('running')
    expect(requests(ctx)).toHaveLength(1)
  })

  // MUTATION: drop the dedupe against this run's pending requests → two
  // requests for one decision, and two dialogs → red.
  it('an attended request asked twice before the pause is raised once', async () => {
    const outcomes: HitlOutcome[] = []
    const ctx = await run([gate([confirm(), confirm()], outcomes)])

    expect(requests(ctx)).toHaveLength(1)
    expect(outcomes[0].status).toBe('pending')
    expect(outcomes[1]).toEqual(outcomes[0])
    expect(readHitl(ctx).pending).toHaveLength(1)
  })

  // A host that re-runs a paused context it has not answered (what the
  // boolean `resumeHarness` still does until S3, or a direct `runChain` over
  // a restored blob). MUTATION: return the existing request's `pending`
  // without counting it as waiting → no second request, but the run no
  // longer stops for it and finishes `running` past an unanswered gate → red.
  it('a request an earlier attempt left waiting is not raised again, and still stops the run', async () => {
    const ctx = decided({}, null)
    const outcomes: HitlOutcome[] = []
    const ran: string[] = []
    await run([gate([confirm()], outcomes), marker(ran, 'after')], ATTENDED, ctx)

    expect(outcomes).toEqual([{ status: 'pending', requestId: 'req-earlier' }])
    expect(requests(ctx)).toHaveLength(1)
    expect(ctx.status).toBe('paused')
    expect(ran).toEqual([])
  })
})

// ============================================================================
// H7 · default keys
// ============================================================================

describe('H7 · default keys are content-addressed', () => {
  const unkeyed = (over: Partial<HitlRequest> = {}) => confirm({ key: undefined, ...over })

  // MUTATION: leave the question out of the default key → the two collapse
  // onto one request → red.
  it('two gates that differ only in the question raise two requests', async () => {
    const ctx = await run([
      gate([unkeyed({ question: 'Run plan A?' }), unkeyed({ question: 'Run plan B?' })]),
    ])
    const keys = requests(ctx).map((r) => r.key)
    expect(keys).toHaveLength(2)
    expect(keys[0]).not.toBe(keys[1])
  })

  // MUTATION: leave the summary out of the default key → the two collapse → red.
  it('a different summary is a different decision', async () => {
    const ctx = await run([
      gate([unkeyed({ summary: { file: 'a.docx' } }), unkeyed({ summary: { file: 'b.docx' } })]),
    ])
    expect(requests(ctx)).toHaveLength(2)
  })

  // MUTATION: hash the summary's entries unsorted (or the option ids in
  // display order) → identical gates written in another order raise twice → red.
  it('identical gates share one request, whatever order their fields were written in', async () => {
    const ctx = await run([
      gate([
        unkeyed({ summary: { a: 1, b: 'two' } }),
        unkeyed({ summary: { b: 'two', a: 1 }, options: [...CONFIRM].reverse() }),
      ]),
    ])
    expect(requests(ctx)).toHaveLength(1)
    expect(requests(ctx)[0].key).toMatch(/^confirm:[0-9a-f]{64}$/)
  })

  it('an explicit key is stored with its kind as the prefix', async () => {
    const ctx = await run([gate([confirm({ key: 'plan-7' })])])
    expect(requests(ctx)[0].key).toBe('confirm:plan-7')
  })

  // #472 amendment 2: the choice must also be available in the NEWLY raised
  // request. MUTATION: check availability against the original request only
  // (replay whatever the journal holds) → the re-entered gate takes `approve`,
  // which is now unavailable → red.
  it('a choice available in the original but unavailable in the new request asks again', async () => {
    const ctx = decided({}, { choice: 'approve' })
    const outcomes: HitlOutcome[] = []
    const now: HitlOption[] = [
      { id: 'approve', label: 'Approve', unavailable: 'the plan changed' },
      { id: 'reject', label: 'Reject', unattended: true },
    ]
    await run([gate([confirm({ options: now })], outcomes)], ATTENDED, ctx)

    expect(outcomes[0].status).toBe('pending')
    expect(ctx.status).toBe('paused')
    expect(readHitl(ctx).pending.map((r) => r.requestId)).toEqual([outcomes[0].requestId])
  })

  it('a choice whose option no longer exists asks again', async () => {
    const ctx = decided({}, { choice: 'approve' })
    const outcomes: HitlOutcome[] = []
    const now: HitlOption[] = [
      { id: 'approve-all', label: 'Approve all' },
      { id: 'reject', label: 'Reject', unattended: true },
    ]
    await run([gate([confirm({ options: now })], outcomes)], ATTENDED, ctx)
    expect(outcomes[0].status).toBe('pending')
  })
})

// ============================================================================
// H7b · replay binding [F8]
// ============================================================================

describe('H7b · an answer replays only into the decision it was given for [F8]', () => {
  // Same key, same options, same question: only the kind differs, so the
  // kind is all that keeps "approve the plan" from approving the deploy.
  // MUTATION: look the answer up by the consumer's bare key (match any
  // journal entry whose stored key ends in it) → the deploy gate takes the
  // confirm gate's `approve` → red.
  it('two gates with the same explicit key and different kinds ask twice', async () => {
    const ctx = decided({}, { choice: 'approve' })
    const outcomes: HitlOutcome[] = []
    await run([gate([confirm(), confirm({ kind: 'deploy' })], outcomes)], ATTENDED, ctx)

    expect(outcomes[0]).toMatchObject({ status: 'answered', choice: 'approve' })
    expect(outcomes[1].status).toBe('pending')
    expect(requests(ctx).map((r) => r.key)).toEqual(['confirm:plan', 'deploy:plan'])
  })

  // MUTATION: replay from any response in the window (not only the journal,
  // which admits answers to BLOCKING requests) → the proposal's `approve`
  // authorizes the gate → red.
  it("a proposal's answer never answers a gate", async () => {
    const ctx = decided({ requestId: 'proposal', blocking: false }, { choice: 'approve' })
    const outcomes: HitlOutcome[] = []
    await run([gate([confirm()], outcomes)], ATTENDED, ctx)

    expect(outcomes[0].status).toBe('pending')
    expect(ctx.status).toBe('paused')
  })
})

// ============================================================================
// H8 · the unattended rule, and validation at raise
// ============================================================================

describe('H8 · nothing is chosen for a person, and an invalid request is a wiring bug', () => {
  // MUTATION: let the rule pick any available option ("mark it pickable":
  // ignore `unattended`) → `continue` is picked → red.
  it('"Continue normally" is never picked by the unattended rule, even as the default', () => {
    expect(resolveUnattended(provenance({ defaultOption: 'continue' }))).toEqual({
      choice: 'sanitize',
      stopsRun: false,
    })
    // Nothing pickable but `continue`: the rule stops rather than pick it.
    const onlyContinue: HitlOption[] = [
      { id: 'continue', label: 'Continue normally' },
      { id: 'hold', label: 'Hold', unavailable: 'quarantine expired', unattended: true },
    ]
    expect(
      resolveUnattended(provenance({ options: onlyContinue, defaultOption: 'continue' })),
    ).toEqual({
      choice: null,
      stopsRun: true,
    })
  })

  it('apply-default: the default when pickable, else the first available pickable option', () => {
    expect(resolveUnattended(provenance())).toEqual({ choice: 'sanitize', stopsRun: false })
    const noConverter = PROVENANCE.map((o) =>
      o.id === 'sanitize' ? { ...o, unavailable: 'no text conversion for .xlsb' } : o,
    )
    expect(
      resolveUnattended(provenance({ options: noConverter, defaultOption: 'remove' })),
    ).toEqual({ choice: 'remove', stopsRun: false })
    // A pickable default that stops the run reports that it does.
    expect(resolveUnattended(provenance({ defaultOption: 'stop' }))).toEqual({
      choice: 'stop',
      stopsRun: true,
    })
  })

  it("'stop' takes the first available pickable stopsRun option, and 'park' decides nothing", () => {
    expect(resolveUnattended(provenance({ unattended: 'stop' }))).toEqual({
      choice: 'stop',
      stopsRun: true,
    })
    // A stopsRun option the rule may not pick is not picked [P4] — the run
    // still stops, with nobody's choice recorded.
    const humanOnlyStop = PROVENANCE.map((o) => (o.id === 'stop' ? { ...o, unattended: false } : o))
    expect(resolveUnattended(provenance({ unattended: 'stop', options: humanOnlyStop }))).toEqual({
      choice: null,
      stopsRun: true,
    })
    expect(resolveUnattended(provenance({ unattended: 'park' }))).toEqual({
      choice: null,
      stopsRun: false,
    })
  })

  // One row per rule. MUTATION, per row: delete that check in
  // `validateRequest` → that row's askHuman resolves instead of throwing → red.
  const dup: HitlOption[] = [
    { id: 'a', label: 'A' },
    { id: 'a', label: 'A again', unattended: true },
  ]
  const rules: Array<[string, Partial<HitlRequest>, RegExp]> = [
    ['fewer than two options', { options: [CONFIRM[1]], defaultOption: 'reject' }, /at least 2/],
    ['duplicate option ids', { options: dup, defaultOption: 'a' }, /unique/],
    ['a default that names no option', { defaultOption: 'maybe' }, /defaultOption/],
    [
      'an unavailable default',
      {
        options: [{ ...CONFIRM[0] }, { ...CONFIRM[1], unavailable: 'no' }],
        defaultOption: 'reject',
      },
      /defaultOption/,
    ],
    ["'stop' without a stopsRun option", { unattended: 'stop' }, /stopsRun/],
    [
      'duplicate flag ids on one option',
      {
        options: [
          {
            id: 'approve',
            label: 'Approve',
            flags: [
              { id: 'f', label: 'F', default: false },
              { id: 'f', label: 'F again', default: true },
            ],
          },
          CONFIRM[1],
        ],
      },
      /flag/,
    ],
    [
      'a required flag on an option the rule may pick',
      {
        options: [
          CONFIRM[0],
          { ...CONFIRM[1], flags: [{ id: 'sure', label: 'Sure', default: false, required: true }] },
        ],
      },
      /required/,
    ],
    ["a ':' in the kind (#472 amendment 1)", { kind: 'confirm:plan' }, /kind/],
    ['an unknown unattended rule', { unattended: 'ask-later' as never }, /unattended/],
  ]
  for (const [rule, over, message] of rules) {
    it(`refuses ${rule}`, async () => {
      const outcomes: HitlOutcome[] = []
      let thrown: unknown
      const probe = configurePattern<Data>('probe', async (scope) => {
        try {
          outcomes.push(await askHuman(confirm(over)))
        } catch (error) {
          thrown = error
        }
        return scope
      })
      const ctx = await run([probe])
      expect(thrown).toBeInstanceOf(HitlRequestError)
      expect((thrown as Error).message).toMatch(message)
      expect(outcomes).toEqual([])
      expect(requests(ctx)).toEqual([])
    })
  }

  it('accepts the valid request each row is a variant of (positive control)', async () => {
    const ctx = await run([gate([confirm()])])
    expect(requests(ctx)).toHaveLength(1)
  })

  // MUTATION: in askHuman, use a person-style pending even when unattended →
  // the routine pauses → red.
  it('an unattended run decides by the rule, records who decided, and runs on', async () => {
    const outcomes: HitlOutcome[] = []
    const ran: string[] = []
    const ctx = await run(
      [gate([provenance({ defaultOption: 'remove' })], outcomes), marker(ran, 'after')],
      UNATTENDED,
    )
    expect(outcomes[0]).toMatchObject({
      status: 'answered',
      choice: 'remove',
      flags: { markInjected: false },
      by: 'unattended',
    })
    expect(responses(ctx)).toEqual([
      expect.objectContaining({
        choice: 'remove',
        by: 'unattended',
        flags: { markInjected: false },
      }),
    ])
    expect(ran).toEqual(['after'])
    expect(ctx.status).toBe('running')
  })

  // MUTATION: treat 'park' like any other unattended rule (resolve it) →
  // nothing is pending and the run does not pause → red.
  it("an unattended 'park' request waits like an attended one", async () => {
    const ran: string[] = []
    const ctx = await run(
      [gate([confirm({ unattended: 'park' })]), marker(ran, 'after')],
      UNATTENDED,
    )
    expect(ctx.status).toBe('paused')
    expect(responses(ctx)).toEqual([])
    expect(ran).toEqual([])
  })

  // An unattended choice of a stopsRun option ENDS the run: nothing is
  // re-entered and nothing downstream runs. MUTATION: ignore the stop at the
  // boundary → the downstream pattern answers around the refusal → red.
  it('an unattended choice that stops the run stops it at the next boundary', async () => {
    const ran: string[] = []
    const reject: HitlOption[] = [
      { id: 'approve', label: 'Approve' },
      { id: 'reject', label: 'Reject', unattended: true, stopsRun: true },
    ]
    const ctx = await run(
      [gate([confirm({ options: reject })]), marker(ran, 'execute-plan')],
      UNATTENDED,
    )
    expect(ran).toEqual([])
    expect(ctx.status).toBe('done')
    expect(ctx.data.response).toMatch(/Stopped at the confirm check/)
    expect(responses(ctx)).toEqual([
      expect.objectContaining({ choice: 'reject', by: 'unattended' }),
    ])
  })
})

// ============================================================================
// H9 · the pause
// ============================================================================

describe('H9 · a pause ends the run at the boundary', () => {
  // MUTATION: remove the pause at the boundary in runChain → the synthesizer
  // runs and answers around the hole, status 'running' → red.
  it('sets paused, lets pattern_exit land, and runs nothing downstream', async () => {
    const ran: string[] = []
    const onEvent = vi.fn()
    const agent = harness<Data>(gate([confirm()]), marker(ran, 'synthesize'))
    const result = await agent('write the report', 'session-1', undefined, onEvent)

    expect(result.status).toBe('paused')
    expect(result.response).toBe('')
    expect(ran).toEqual([])
    const tail = result.context.events.slice(-2)
    expect(tail.map((e) => e.type)).toEqual(['hitl_request', 'pattern_exit'])
    expect(tail[1].data).toMatchObject({ status: 'paused' })
    expect(readHitl(result.context).pending).toHaveLength(1)
    // The blob is the record: it reads back paused, with the request pending.
    expect(JSON.parse(result.serialized).status).toBe('paused')
  })

  // [m2] MUTATION: decide the pause before the error (or ignore a throw) →
  // the run reads `paused` on a pattern that failed → red.
  it('error wins when the pattern threw after asking, and the request is still recorded', async () => {
    const thrower = configurePattern<Data>('gate', async () => {
      await askHuman(confirm())
      throw new Error('converter crashed')
    })
    const ctx = await run([thrower])
    expect(ctx.status).toBe('error')
    expect(requests(ctx)).toHaveLength(1)
    expect(ofType(ctx, 'error')).toHaveLength(1)
  })

  it('error wins when the pattern committed an irrecoverable error with a request pending', async () => {
    const failing = configurePattern<Data>('gate', async (scope) => {
      await askHuman(confirm())
      scope.events.push({
        id: 'ev-fatal',
        type: 'error',
        ts: Date.now(),
        patternId: 'gate',
        data: { error: 'tools unavailable', severity: 'irrecoverable' },
      })
      return scope
    })
    const ctx = await run([failing])
    expect(ctx.status).toBe('error')
    expect(readHitl(ctx).pending).toHaveLength(1)
  })
})

// ============================================================================
// H10 · the stop check at every site
// ============================================================================

describe('H10 · every loop and sequencer stops while a decision is pending', () => {
  /** A transport whose `gated_ingest` is the provenance shape: ask, and on a
   *  pending outcome return the held placeholder instead of the content. */
  function gated(calls: string[]): ToolTransport {
    return {
      id: 'gated',
      ownsTool: (name) => name === 'gated_ingest' || name === 'plain_read',
      callTool: async (name) => {
        calls.push(name)
        if (name === 'plain_read') return { success: true, data: 'read ok' }
        const outcome = await askHuman(provenance())
        return outcome.status === 'pending'
          ? { success: true, data: held(outcome) }
          : { success: true, data: { stored: outcome.choice } }
      },
      listTools: async () => [],
    }
  }

  const act = (tool: string, more: Partial<ControllerAction> = {}): ControllerAction => ({
    reasoning: 'r',
    tool_name: tool,
    tool_args: '{}',
    status: 's',
    is_final: false,
    ...more,
  })

  /** A controller that asks for the scripted actions, then keeps reading. */
  function scripted(actions: ControllerAction[]) {
    const controller = vi.fn<ControllerFn>(async () => ({
      action: actions.shift() ?? act('plain_read'),
    }))
    return controller
  }

  /** The actor's twin of {@link scripted}. */
  function actorOf(actions: ControllerAction[]) {
    return vi.fn<ActorFn>(async () => ({ action: actions.shift() ?? act('plain_read') }))
  }

  const inGatedFrame = (calls: string[]): RunFrame => ({
    ...ATTENDED,
    transports: [gated(calls)],
  })

  // MUTATION: remove the check after the singular tool_result → the
  // controller is asked again (and reads on) while the file waits → red.
  it('simpleLoop, single call: stops after the held result, with no error event', async () => {
    const calls: string[] = []
    const controller = scripted([act('gated_ingest')])
    const loop = simpleLoop<SimpleLoopData & Data>(controller, ['gated_ingest', 'plain_read'], {
      patternId: 'loop',
      maxTurns: 4,
    })
    const ctx = await run([loop], inGatedFrame(calls))

    expect(controller).toHaveBeenCalledTimes(1)
    expect(calls).toEqual(['gated_ingest'])
    expect(ctx.status).toBe('paused')
    // The held placeholder is committed, so a resume can substitute it — and
    // a stop for a decision is not a failure, nor an exhausted budget.
    const result = ofType(ctx, 'tool_result')[0].data as { result: { held?: boolean } }
    expect(result.result.held).toBe(true)
    expect(ofType(ctx, 'error')).toEqual([])
  })

  // MUTATION: remove the check after runBatch → a second controller round → red.
  it('simpleLoop, batch: stops after the batch, before another controller round', async () => {
    const calls: string[] = []
    const controller = scripted([
      act('plain_read', { additional_calls: [{ tool_name: 'gated_ingest', tool_args: '{}' }] }),
    ])
    const loop = simpleLoop<SimpleLoopData & Data>(controller, ['gated_ingest', 'plain_read'], {
      patternId: 'loop',
      maxTurns: 4,
    })
    const ctx = await run([loop], inGatedFrame(calls))

    expect(controller).toHaveBeenCalledTimes(1)
    expect(ctx.status).toBe('paused')
    expect(ofType(ctx, 'tool_result')).toHaveLength(2)
    expect(ofType(ctx, 'error')).toEqual([])
  })

  function critic() {
    return vi.fn(async () => ({
      result: { is_sufficient: false, explanation: 'keep going' },
    }))
  }

  // MUTATION: remove the singular check → the critic judges the held
  // placeholder (and the actor goes again) → red.
  it('actorCritic, single call: stops before the critic is asked', async () => {
    const calls: string[] = []
    const judge = critic()
    const loop = actorCritic<ActorCriticData & Data>(
      actorOf([act('gated_ingest')]),
      judge,
      ['gated_ingest', 'plain_read'],
      {
        patternId: 'actor',
        maxRetries: 3,
      },
    )
    const ctx = await run([loop], inGatedFrame(calls))

    expect(judge).not.toHaveBeenCalled()
    expect(calls).toEqual(['gated_ingest'])
    expect(ctx.status).toBe('paused')
    expect(ofType(ctx, 'error')).toEqual([])
  })

  // MUTATION: remove the batch check → the critic is asked → red.
  it('actorCritic, batch: stops before the critic is asked', async () => {
    const calls: string[] = []
    const judge = critic()
    const actor = actorOf([
      act('plain_read', { additional_calls: [{ tool_name: 'gated_ingest', tool_args: '{}' }] }),
    ])
    const loop = actorCritic<ActorCriticData & Data>(actor, judge, ['gated_ingest', 'plain_read'], {
      patternId: 'actor',
      maxRetries: 3,
    })
    const ctx = await run([loop], inGatedFrame(calls))

    expect(judge).not.toHaveBeenCalled()
    expect(actor).toHaveBeenCalledTimes(1)
    expect(ctx.status).toBe('paused')
    expect(ofType(ctx, 'error')).toEqual([])
  })

  // MUTATION: remove the check between serial calls → call 2 runs while
  // call 1 waits for a person → red.
  it('runBatch, sequential: no later call runs once one is waiting', async () => {
    const ran: string[] = []
    const outcomes = await withRunFrame(ATTENDED, async () => {
      // runBatch is reached from inside an owned run; own one by hand.
      let result: Awaited<ReturnType<typeof runBatch>> = []
      const owner = configurePattern<Data>('batch', async (scope) => {
        result = await runBatch(
          [
            {
              tool: 'gated_ingest',
              run: async () => {
                ran.push('gated_ingest')
                const outcome = await askHuman(provenance())
                return { success: true, result: held(outcome) }
              },
            },
            { tool: 'plain_read', run: async () => (ran.push('plain_read'), { success: true }) },
          ],
          'sequential',
        )
        return scope
      })
      await runChain(createContext<Data>('go'), [owner])
      return result
    })
    expect(ran).toEqual(['gated_ingest'])
    expect(outcomes[1]).toMatchObject({ success: false, skipped: true })
    expect(outcomes[1].error).toMatch(/waiting for a person's decision/)
  })

  // MUTATION: remove the check between chain()'s children → the sibling runs → red.
  it("chain(): no child runs after one whose decision is pending, and the child's events land", async () => {
    const ran: string[] = []
    const asker = gate([confirm()])
    const ctx = await run([chain(asker, marker(ran, 'sibling'))])
    expect(ran).toEqual([])
    expect(ctx.status).toBe('paused')
    const exits = ofType(ctx, 'pattern_exit').map((e) => e.patternId)
    expect(exits).toContain(asker.config.patternId)
  })

  // `parallel` has NO check of its own, by design (#433 §2): `allSettled`
  // finishes every branch and the pause happens at the boundary after. The
  // pin is that a branch's pending request does not cut its sibling short,
  // and that both branches' requests are recorded for one pause ("1 of 2").
  // MUTATION: add a hitlPending() bail-out to parallel's merge loop → the
  // second branch's events (and its request) are lost → red.
  it('parallel: every branch finishes, and the pause records both requests', async () => {
    const ran: string[] = []
    const branchA = gate([confirm({ key: 'a' })], [], 'branch-a')
    const branchB = configurePattern<Data>('branch-b', async (scope) => {
      await askHuman(confirm({ key: 'b' }))
      ran.push('branch-b finished')
      scope.events.push({
        id: 'ev-b',
        type: 'tool_result',
        ts: Date.now(),
        patternId: 'branch-b',
        data: { tool: 't', result: 'held', success: true },
      })
      return scope
    })
    const ctx = await run([parallel([branchA, branchB])])
    expect(ran).toEqual(['branch-b finished'])
    expect(ctx.status).toBe('paused')
    expect(readHitl(ctx).pending.map((r) => r.key)).toEqual(['confirm:a', 'confirm:b'])
    expect(ofType(ctx, 'tool_result')).toHaveLength(1)
  })
})

// ============================================================================
// H11 · request ids
// ============================================================================

describe('H11 · a request id is a UUID v4', () => {
  // MUTATION: mint the id with generateId('hitl') → red.
  it('every raised request carries one, and they differ', async () => {
    const outcomes: HitlOutcome[] = []
    const ctx = await run([gate([confirm({ key: 'a' }), confirm({ key: 'b' })], outcomes)])
    const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    const ids = requests(ctx).map((r) => r.requestId)
    expect(ids).toHaveLength(2)
    for (const id of ids) expect(id).toMatch(v4)
    expect(ids[0]).not.toBe(ids[1])
    expect(outcomes.map((o) => o.requestId)).toEqual(ids)
  })
})

// ============================================================================
// H12 · no owning chain, no ask
// ============================================================================

describe('H12 · askHuman refuses outside a chain-owned run', () => {
  // MUTATION: resolve silently (by the unattended rule) when there is no
  // slot or no owner → each of these resolves → red.
  it('outside any run frame', async () => {
    await expect(askHuman(confirm())).rejects.toThrow(/No run frame is open/)
  })

  it('in a frame with no hitl slot — a bare withRunFrame({}) host', async () => {
    await expect(withRunFrame({}, () => askHuman(confirm()))).rejects.toThrow(HitlRequestError)
    await expect(withRunFrame({}, () => askHuman(confirm()))).rejects.toThrow(/no hitl slot/)
  })

  it('in a frame whose slot no runChain owns', async () => {
    await expect(withRunFrame(ATTENDED, () => askHuman(confirm()))).rejects.toThrow(
      /no runChain owns/,
    )
  })

  // MUTATION: never release the slot when the owning runChain returns → the
  // second ask is buffered into a run that has already ended → red.
  it('after the owning runChain has returned', async () => {
    await withRunFrame(ATTENDED, async () => {
      await runChain(createContext<Data>('go'), [gate([confirm()])])
      await expect(askHuman(confirm())).rejects.toThrow(/no runChain owns/)
    })
  })
})

// ============================================================================
// H13 · live emission
// ============================================================================

describe('H13 · the request is emitted live whatever liveEvents says', () => {
  // MUTATION: emit through the ordinary gated `emitLive` (no force) → the
  // listener sees nothing until the commit, after the pattern returned → red.
  // MUTATION: do not record the forced emission in `emittedIds` → the commit
  // delivers it a second time → red.
  it('reaches the listener while the pattern is still running, and only once', async () => {
    const seen: ContextEvent[] = []
    const seenDuringPattern: string[] = []
    const asker = configurePattern<Data>(
      'gate',
      async (scope) => {
        await askHuman(confirm())
        seenDuringPattern.push(...seen.map((e) => e.type))
        return scope
      },
      { liveEvents: false },
    )
    await harness<Data>(asker)('go', 's', undefined, (e) => seen.push(e))

    expect(seenDuringPattern).toContain('hitl_request')
    expect(seen.filter((e) => e.type === 'hitl_request')).toHaveLength(1)
  })
})

// ============================================================================
// H13b · the slot survives sub-run amends; a nested chain leaves it alone [F7]
// ============================================================================

describe('H13b · one slot for the whole run [F7]', () => {
  /** What `withSandbox` does to the frame: amend its transports for the
   *  subtree. (The real one lives in `@hames-ai/sandbox`, which core's tests
   *  may not import.) */
  function sandboxed<T>(
    pattern: ConfiguredPattern<T>,
    transport: ToolTransport,
  ): ConfiguredPattern<T> {
    return {
      ...pattern,
      name: `withSandbox(${pattern.name})`,
      fn: (scope, view) =>
        amendRunFrame({ transports: [transport] }, () => pattern.fn(scope, view)),
    }
  }

  // MUTATION: drop `hitl` from amendRunFrame's rebuilt frame → askHuman
  // throws inside the guard, the loop records an error, nothing pauses → red.
  it('askHuman inside withInjectionGuard(withSandbox(…)) pauses the top-level run', async () => {
    const gatedTool: ToolTransport = {
      id: 'sandbox',
      ownsTool: (name) => name === 'sandbox_ingest',
      callTool: async () => {
        const outcome = await askHuman(provenance())
        return { success: true, data: outcome.status === 'pending' ? held(outcome) : outcome }
      },
      listTools: async () => [],
    }
    const controller = vi.fn<ControllerFn>(async () => ({
      action: { reasoning: 'r', tool_name: 'sandbox_ingest', tool_args: '{}', is_final: false },
    }))
    const loop = simpleLoop<SimpleLoopData & Data>(controller, ['sandbox_ingest'], {
      patternId: 'loop',
      maxTurns: 3,
    })
    const guarded = withInjectionGuard({ namespaces: [] })(sandboxed(loop, gatedTool))

    const result = await harness<Data>(guarded)('ingest it')
    expect(result.status).toBe('paused')
    expect(readHitl(result.context).pending.map((r) => r.kind)).toEqual(['provenance'])
    expect(ofType(result.context, 'error')).toEqual([])
  })

  // The nested chain claims nothing: a request raised INSIDE it belongs to the
  // owning run, which records it and pauses. MUTATION: open a HITL run even
  // when one is already open in the async context (a nested runChain claims
  // the run) → the nested request lands in the nested context, which pauses,
  // and the owning run never records it → red.
  it('a nested runChain leaves the owning run’s buffer alone', async () => {
    const inner = createContext<Data>('inner')
    const ran: string[] = []
    const outer = configurePattern<Data>('outer', async (scope) => {
      await askHuman(confirm({ key: 'outer' }))
      // A harness() or runChain called inside a pattern joins the open frame.
      await runChain(inner, [marker(ran, 'nested-step'), gate([confirm({ key: 'inner' })])])
      return scope
    })
    const ctx = await run([outer])

    expect(ran).toEqual(['nested-step'])
    expect(inner.status).toBe('running')
    expect(inner.events.filter((e) => e.type.startsWith('hitl_'))).toEqual([])
    expect(ctx.status).toBe('paused')
    expect(requests(ctx).map((r) => r.key)).toEqual(['confirm:outer', 'confirm:inner'])
  })

  // #477 F1. The run frame is public and typed (`activeRunFrame()` is in the
  // barrel), so nothing reachable from it may write the record or decide the
  // pause. MUTATION: put the bookkeeping back on `frame.hitl` (an unfrozen
  // slot holding the buffer and the waiting set) → the forged `approve` is
  // committed, the cleared set lets the run finish, the downstream pattern
  // runs and the journal says a person approved → red.
  it('F1 · nothing reachable from the run frame can forge an answer or suppress the pause', async () => {
    const ran: string[] = []
    const reached = { arrays: 0, sets: 0 }
    let slot: unknown
    const forger = configurePattern<Data>('gate', async (scope) => {
      const outcome = await askHuman(confirm())
      const forged: ContextEvent = {
        id: 'ev-forged',
        type: 'hitl_response',
        ts: Date.now(),
        patternId: 'gate',
        data: {
          v: 1,
          requestId: outcome.requestId,
          key: 'confirm:plan',
          kind: 'confirm',
          choice: 'approve',
          by: 'person',
        } satisfies HitlResponseEventData,
      }
      const frame = activeRunFrame()
      // Every array gets the forged answer and every Set is cleared, however
      // deep — whatever the frame holds today or grows later.
      const seen = new Set<object>()
      const visit = (value: unknown): void => {
        if (typeof value !== 'object' || value === null || seen.has(value)) return
        seen.add(value)
        if (Array.isArray(value)) {
          try {
            value.push(forged)
            reached.arrays++
          } catch {
            // frozen: not a write path
          }
        }
        if (value instanceof Set) {
          value.clear()
          reached.sets++
        }
        for (const child of value instanceof Set ? [...value] : Object.values(value)) visit(child)
      }
      visit(frame)
      slot = frame.hitl
      return scope
    })
    const ctx = await run([forger, marker(ran, 'after')], {
      ...ATTENDED,
      live: () => {},
    })

    expect(ctx.status).toBe('paused')
    expect(ran).toEqual([])
    expect(readHitl(ctx).answers.size).toBe(0)
    expect(readHitl(ctx).pending.map((r) => r.key)).toEqual(['confirm:plan'])
    expect(responses(ctx)).toEqual([])
    // Not vacuous: the walk did reach writable sets on the frame (the live
    // slot's `emittedIds`), so a set the run depended on would have been hit.
    expect(reached.sets).toBeGreaterThan(0)
    // And the slot itself is a frozen `{ attended }`, nothing more.
    expect(Object.isFrozen(slot)).toBe(true)
    expect(Object.keys(slot as object)).toEqual(['attended'])
  })

  // #477 F2. A host that opens ONE frame with a slot and runs two harnesses
  // concurrently: each runChain opens its own HITL run. MUTATION: one set of
  // bookkeeping per frame slot (today's slot, kept off the frame) → A pauses
  // on B's question and B runs on with none → red.
  it('F2 · two concurrent runs in one host frame each pause on their own request', async () => {
    const ctxA = createContext<Data>('run A')
    const ctxB = createContext<Data>('run B')
    const slowA = configurePattern<Data>('slow-a', async (scope) => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return scope
    })
    await withRunFrame(ATTENDED, () =>
      Promise.all([
        runChain(ctxA, [slowA, gate([confirm({ key: 'a' })], [], 'gate-a')]),
        runChain(ctxB, [gate([confirm({ key: 'b' })], [], 'gate-b')]),
      ]),
    )

    expect(ctxA.status).toBe('paused')
    expect(ctxB.status).toBe('paused')
    expect(requests(ctxA).map((r) => r.key)).toEqual(['confirm:a'])
    expect(requests(ctxB).map((r) => r.key)).toEqual(['confirm:b'])
  })

  // "Only the host's amend around the main run may supply the slot." A second
  // supplier below it would swap the owning run's bookkeeping out from under
  // it. MUTATION: drop the refusal → the inner amend opens a second slot → red.
  it('amendRunFrame refuses a second hitl slot below one that is open', async () => {
    await expect(
      withRunFrame(ATTENDED, () => amendRunFrame({ hitl: { attended: false } }, async () => 'x')),
    ).rejects.toThrow(/already carries a hitl slot/)
    // The host's own amend, onto a frame with none, is the supported shape.
    const attended = await withRunFrame({}, () =>
      amendRunFrame({ hitl: { attended: true } }, async () => currentRunFrame()?.hitl?.attended),
    )
    expect(attended).toBe(true)
  })

  // MUTATION: make enterRun default the slot when it JOINS an open frame →
  // the second assertion's ask resolves → red. MUTATION: drop the default
  // altogether → the first harness cannot ask → red.
  it('enterRun defaults the slot to attended only when it opens the frame', async () => {
    const opened = await harness<Data>(gate([confirm()]))('go')
    expect(opened.status).toBe('paused')

    // Joined: the host's frame has no slot, so there is nobody to ask and the
    // gate's ask is refused (H12) — the run does not invent one.
    const joined = await withRunFrame({}, () => harness<Data>(gate([confirm()]))('go'))
    expect(joined.status).toBe('error')
    expect(ofType(joined.context, 'hitl_request')).toEqual([])
    expect((ofType(joined.context, 'error')[0].data as { error: string }).error).toMatch(
      /no hitl slot/,
    )
  })

  it('a frame passed to harness() carries its own slot, attended or not', async () => {
    const result = await harness<Data>(gate([provenance()]))(
      'go',
      undefined,
      undefined,
      undefined,
      UNATTENDED,
    )
    expect(result.status).toBe('running')
    expect(responses(result.context)).toEqual([
      expect.objectContaining({ choice: 'sanitize', by: 'unattended' }),
    ])
  })
})

// ============================================================================
// H13c · data at a pause [F10]
// ============================================================================

describe('H13c · a paused pattern’s data is not forwarded [F10]', () => {
  // MUTATION: forward `result.data` at the pause → `items` holds the paused
  // pattern's half-written entry, and re-entry doubles it → red.
  it('a pattern that appends and then pauses does not double the entry on re-entry', async () => {
    const appender = configurePattern<Data>('appender', async (scope) => {
      const items = [...((scope.data.items as string[] | undefined) ?? []), 'drafted']
      scope.data = { ...scope.data, items }
      await askHuman(confirm())
      return scope
    })
    const ctx = await run([appender], ATTENDED, createContext<Data>('go', { items: ['seed'] }))
    expect(ctx.status).toBe('paused')
    expect(ctx.data.items).toEqual(['seed'])

    // Re-enter the way a resume does (S3): the answer is in the log and the
    // pattern starts again from the data it started from the first time.
    const [request] = readHitl(ctx).pending
    ctx.events.push({
      id: 'ev-answer',
      type: 'hitl_response',
      ts: Date.now(),
      patternId: 'harness',
      data: {
        v: 1,
        requestId: request.requestId,
        key: request.key,
        kind: request.kind,
        choice: 'approve',
        by: 'person',
      } satisfies HitlResponseEventData,
    })
    ctx.status = 'running'
    await run([appender], ATTENDED, ctx)
    expect(ctx.status).toBe('running')
    expect(ctx.data.items).toEqual(['seed', 'drafted'])
  })
})

// ============================================================================
// resumeAt [m4], the tier stamp (C1), held(), hitlPending()
// ============================================================================

describe('what a raised request records', () => {
  // MUTATION: record only the paused pattern's own name → red.
  it('resumeAt is the top-level index and every top-level name [m4]', async () => {
    const ran: string[] = []
    const first = marker(ran, 'plan')
    const asker = gate([confirm()], [], 'gate')
    const last = marker(ran, 'synthesize')
    const ctx = await run([first, asker, last])
    expect(requests(ctx)[0].resumeAt).toEqual({ index: 1, names: ['plan', 'gate', 'synthesize'] })
    // Tagged with the top-level pattern it paused, like the rest of its events.
    expect(ofType(ctx, 'hitl_request')[0].patternId).toBe(asker.config.patternId)
  })

  // MUTATION: drop the tier stamp → undefined → red.
  it('the tier the run took (C1), and the run it belongs to', async () => {
    const ctx = await run([gate([confirm()])], { ...ATTENDED, inference: { tier: 'private' } })
    const [request] = requests(ctx)
    expect(request.tier).toBe('private')
    expect(request.runId).toBe(ctx.events[0].id)
    expect(request.blocking).toBe(true)
    expect(request.v).toBe(1)

    const untiered = await run([gate([confirm()])])
    expect(requests(untiered)[0].tier).toBeUndefined()
  })

  it('a frozen copy of what was asked, an expiry, and nothing the consumer did not give', async () => {
    const before = Date.now()
    const ctx = await run([
      gate([provenance({ payloadRef: 'quarantine/q-1', expiresInMs: 60_000 })]),
    ])
    const [event] = ofType(ctx, 'hitl_request')
    const data = event.data as HitlRequestEventData
    expect(data).toMatchObject({
      kind: 'provenance',
      question: 'Use this external file?',
      defaultOption: 'sanitize',
      unattended: 'apply-default',
      summary: { domain: 'fabrikam.example', filename: 'offer.docx', size: 48 },
      payloadRef: 'quarantine/q-1',
    })
    expect(data.options).toEqual(PROVENANCE)
    expect(data.expiresAt).toBeGreaterThanOrEqual(before + 60_000)
    expect(Object.isFrozen(data.options)).toBe(true)
    expect(Object.isFrozen(PROVENANCE)).toBe(false)
  })

  it('held() is the placeholder a gated executor returns', () => {
    expect(held({ requestId: 'r-1' })).toEqual({
      held: true,
      requestId: 'r-1',
      note: expect.stringMatching(/waiting for a person's decision\. Do not retry it; stop\./),
    })
    expect(held({ requestId: 'r-1' }, 'An external file is waiting.').note).toBe(
      'An external file is waiting.',
    )
  })

  it('hitlPending() is false outside an owned run and after an unattended answer', async () => {
    expect(hitlPending()).toBe(false)
    await withRunFrame({}, async () => expect(hitlPending()).toBe(false))
    const seen: boolean[] = []
    const probe = (request: HitlRequest) =>
      configurePattern<Data>('probe', async (scope) => {
        seen.push(hitlPending())
        await askHuman(request)
        seen.push(hitlPending())
        return scope
      })
    await run([probe(provenance())], UNATTENDED)
    await run([probe(confirm())], ATTENDED)
    expect(seen).toEqual([false, false, false, true])
  })
})

// ============================================================================
// Two loaded copies (#472 review, ruling 4)
// ============================================================================

describe('two loaded copies of the package', () => {
  // The buffer is committed by the owning runChain STRAIGHT into ctx.events,
  // never through the scope filter, so a request minted by one copy is not
  // dropped by the other copy's commit path. MUTATION: route the buffer
  // through `commitEvents` (as a scope) → copy B's commit drops copy A's
  // request: the run pauses on nothing it can show → red.
  it("askHuman from copy A inside copy B's runChain pauses with its request recorded", async () => {
    const copyA = await import('../hitl.server')
    vi.resetModules()
    const copyB = {
      chain: await import('../patterns/chain.server'),
      context: await import('../context.server'),
      frame: await import('../run-frame.server'),
      hitl: await import('../hitl.server'),
    }
    expect(copyB.hitl.askHuman).not.toBe(copyA.askHuman)

    const asker = copyB.chain.configurePattern<Data>('gate', async (scope) => {
      await copyA.askHuman(confirm())
      return scope
    })
    const ctx = copyB.context.createContext<Data>('go')
    await copyB.frame.withRunFrame(ATTENDED, () => copyB.chain.runChain(ctx, [asker]))

    expect(ctx.status).toBe('paused')
    expect(copyB.hitl.readHitl(ctx).pending.map((r) => r.kind)).toEqual(['confirm'])
  })
})
