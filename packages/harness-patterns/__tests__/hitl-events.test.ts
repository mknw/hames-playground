/**
 * HITL EVENTS AND THE DERIVATION (#433, slice S1).
 *
 * A human-in-the-loop request and its answer are two events, `hitl_request` and
 * `hitl_response`, and ONE pure reader, `readHitl`, derives everything from
 * them: the run's pending requests and its replay journal (ADR-0009, D17). No
 * decision lives in `ctx.data`. This file pins the slice's five properties
 * (spec §8, H1–H5) and the §2 replay rule [F8] the journal applies:
 *
 *   H1  readHitl reads ONE run: everything after the last `user_message`.
 *   H2  a legacy `approval_*` event is never an answer and never a request.
 *   H3  nothing a request or an answer carries reaches an LLM-facing view;
 *       neither does a legacy `approval_*` payload [F9].
 *   H4  `hitl_*` survive every commit strategy (`ALWAYS_COMMIT_TYPES`).
 *   H5  only core writes them [F6]: `createEvent` / `trackEvent` refuse both
 *       types, and `commitEvents` and `chain()` drop any `hitl_*` event core
 *       did not mint. Since the #472 review (F1), the view is no write path
 *       either: `get()` never returns the live log, and HITL events are
 *       deep-frozen at mint and on deserialize, so a recorded decision cannot
 *       be rewritten in place (pins P-a, P-b, P-e).
 *
 * Every pin names the source mutation that turns it red; each one was run.
 * H2b (a legacy paused blob) belongs to S3, with the `resumeHarness` change.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  commitEvents,
  createContext,
  createEvent,
  createScope,
  deserializeContext,
  mintHitlEvent,
  serializeContext,
  trackEvent,
} from '../context.server'
import { answerOf, hitlReplayKey, readHitl } from '../hitl.server'
import { chain, configurePattern, runChain } from '../patterns/chain.server'
import { createEventView } from '../patterns/event-view.server'
import { withRunFrame } from '../run-frame.server'
import type {
  ContextEvent,
  EventType,
  HitlOption,
  HitlRequestEventData,
  HitlResponseEventData,
  UnifiedContext,
  ViewConfig,
} from '../types'

// ============================================================================
// Fixtures — synthetic throughout
// ============================================================================

const OPTIONS: HitlOption[] = [
  { id: 'approve', label: 'Approve' },
  { id: 'reject', label: 'Reject', unattended: true },
]

function request(over: Partial<HitlRequestEventData> = {}): HitlRequestEventData {
  return {
    v: 1,
    requestId: 'req-a',
    runId: 'ev-run',
    key: 'confirm:plan',
    kind: 'confirm',
    question: 'Run this plan?',
    options: OPTIONS,
    defaultOption: 'reject',
    unattended: 'apply-default',
    summary: {},
    blocking: true,
    ...over,
  }
}

function response(over: Partial<HitlResponseEventData> = {}): HitlResponseEventData {
  return {
    v: 1,
    requestId: 'req-a',
    key: 'confirm:plan',
    kind: 'confirm',
    choice: 'approve',
    by: 'person',
    ...over,
  }
}

let seq = 0
/** A plain event object: what a deserialized blob holds, and what a forger builds. */
function ev(type: EventType, data: unknown, patternId = 'p'): ContextEvent {
  seq++
  return { id: `ev-${seq}`, type, ts: seq, patternId, data }
}

const userMessage = (content: string) => ev('user_message', { content }, 'harness')

function ctxOf(events: ContextEvent[]): UnifiedContext {
  return { sessionId: 's', createdAt: 0, events, status: 'running', data: {}, input: '' }
}

const viewOf = (events: ContextEvent[], config?: ViewConfig) =>
  createEventView(ctxOf(events), config)

const pendingIds = (events: ContextEvent[]) => readHitl({ events }).pending.map((r) => r.requestId)

afterEach(() => {
  vi.restoreAllMocks()
})

// ============================================================================
// H1 · the run window
// ============================================================================

describe('H1 · readHitl reads one run: everything after the last user_message', () => {
  // MUTATION: start the window after the FIRST user_message → run 1's answer
  // is in run 2's journal (`answers.size` 1) and answerOf returns it → red.
  it('an answer from run N is invisible in run N+1', () => {
    const run1 = [
      userMessage('write X'),
      ev('hitl_request', request()),
      ev('hitl_response', response()),
    ]
    // Positive control: inside run 1 the answer IS the journal's.
    expect(readHitl({ events: run1 }).answers.size).toBe(1)
    expect(answerOf(viewOf(run1), 'confirm', 'plan')?.choice).toBe('approve')

    const run2Opener = userMessage('write Y')
    const events = [...run1, run2Opener]
    const state = readHitl({ events })
    expect(state.runId).toBe(run2Opener.id)
    expect(state.answers.size).toBe(0)
    expect(state.pending).toEqual([])
    expect(answerOf(viewOf(events), 'confirm', 'plan')).toBeUndefined()
  })

  // MUTATION: the same first-user_message window → run 1's unanswered request
  // is still pending in run 2 → red.
  it('a request left unanswered in run N is not pending in run N+1', () => {
    const events = [
      userMessage('write X'),
      ev('hitl_request', request()),
      userMessage('never mind, write Y'),
    ]
    expect(readHitl({ events }).pending).toEqual([])
  })

  // MUTATION: the same → the run-2 request replays run 1's `approve`.
  it('the same gate reached in run N+1 is pending there, with nothing to replay', () => {
    const events = [
      userMessage('write X'),
      ev('hitl_request', request()),
      ev('hitl_response', response()),
      userMessage('write Y'),
      ev('hitl_request', request({ requestId: 'req-b' })),
    ]
    const state = readHitl({ events })
    expect(state.pending.map((r) => r.requestId)).toEqual(['req-b'])
    expect(state.answers.size).toBe(0)
  })

  it('treats the whole log as one run when it holds no user_message', () => {
    const events = [ev('hitl_request', request()), ev('hitl_response', response())]
    const state = readHitl({ events })
    expect(state.runId).toBeUndefined()
    expect(state.answers.size).toBe(1)
  })
})

// ============================================================================
// H2 · legacy approval events are inert
// ============================================================================

describe('H2 · a legacy approval_* event is never an answer and never a request', () => {
  // MUTATION: read `approval_response` as a response in readHitl ("derive
  // from it") → the hitl-shaped one answers req-a: it leaves `pending` and
  // fills the journal → red.
  it('an approval_response answers nothing, whatever its payload', () => {
    const events = [
      userMessage('write X'),
      ev('hitl_request', request()),
      // What resumeHarness writes today, and what a 0.1.x blob can hold.
      ev('approval_response', { approved: true }),
      // Shaped exactly like a hitl_response for the pending request.
      ev('approval_response', response()),
    ]
    const state = readHitl({ events })
    expect(state.pending.map((r) => r.requestId)).toEqual(['req-a'])
    expect(state.answers.size).toBe(0)
    expect(answerOf(viewOf(events), 'confirm', 'plan')).toBeUndefined()
  })

  // MUTATION: read `approval_request` as a request in readHitl → it is pending.
  it('an approval_request is never pending', () => {
    const events = [
      userMessage('write X'),
      ev('approval_request', { request: { action: 'write', payload: null, reason: 'r' } }),
      ev('approval_request', request()),
    ]
    expect(readHitl({ events }).pending).toEqual([])
  })
})

// ============================================================================
// The §2 replay rule [F8]
// ============================================================================

describe('the journal applies the §2 replay rule [F8]', () => {
  // MUTATION: drop the replay rule — put every response in the run into the
  // journal, keyed by its own `key` → the first six tests below go red (each
  // journal is non-empty, or the two option sets collapse onto one key), and
  // so does answerOf's ambiguity pin.
  // One condition at a time, each reddens exactly its own test: admit a
  // non-blocking request's answer (the first); skip the kind/key match (the
  // third); skip the available-choice check (the fourth); key the journal by
  // `key` alone (the fifth, the sixth and answerOf's ambiguity pin).

  it("a non-blocking proposal's response never answers a gate", () => {
    const events = [
      userMessage('remember this'),
      ev('hitl_request', request({ requestId: 'prop', blocking: false })),
      ev('hitl_response', response({ requestId: 'prop' })),
    ]
    const state = readHitl({ events })
    expect(state.answers.size).toBe(0)
    // A proposal never blocks the run, answered or not.
    expect(state.pending).toEqual([])
    expect(pendingIds(events.slice(0, 2))).toEqual([])
  })

  it('a response whose requestId names no request in this run is not an answer', () => {
    const events = [
      userMessage('write X'),
      ev('hitl_request', request({ requestId: 'req-old' })),
      userMessage('write Y'),
      ev('hitl_response', response({ requestId: 'req-old' })),
      ev('hitl_response', response({ requestId: 'req-nowhere' })),
    ]
    expect(readHitl({ events }).answers.size).toBe(0)
  })

  it('a response must carry the kind and key of the request it names', () => {
    for (const forged of [response({ kind: 'provenance' }), response({ key: 'confirm:other' })]) {
      const events = [
        userMessage('write X'),
        ev('hitl_request', request()),
        ev('hitl_response', forged),
      ]
      const state = readHitl({ events })
      expect(state.answers.size).toBe(0)
      // §2: pending is "no response with the same requestId", so the mismatched
      // response still closes the request. It just never replays: the next
      // raise of that gate asks again.
      expect(state.pending).toEqual([])
    }
  })

  it('a choice that is not an available option of its request is not an answer', () => {
    const withUnavailable = request({
      options: [...OPTIONS, { id: 'sanitize', label: 'Sanitize', unavailable: 'no converter' }],
    })
    for (const [req, res] of [
      [request(), response({ choice: 'delete-everything' })],
      [withUnavailable, response({ choice: 'sanitize' })],
      [request(), response({ choice: null, by: 'expired' })],
    ] as const) {
      const events = [userMessage('write X'), ev('hitl_request', req), ev('hitl_response', res)]
      expect(readHitl({ events }).answers.size).toBe(0)
    }
  })

  it('keys the journal by kind, key AND option-id set, never by key alone', () => {
    const wider = [...OPTIONS, { id: 'defer', label: 'Later' }]
    const events = [
      userMessage('write X'),
      ev('hitl_request', request()),
      ev('hitl_response', response({ choice: 'reject' })),
      ev('hitl_request', request({ requestId: 'req-b', options: wider })),
      ev('hitl_response', response({ requestId: 'req-b', choice: 'approve' })),
    ]
    const { answers } = readHitl({ events })
    expect(answers.size).toBe(2)
    expect(answers.get(hitlReplayKey(request()))?.choice).toBe('reject')
    expect(answers.get(hitlReplayKey(request({ options: wider })))?.choice).toBe('approve')
  })

  // MUTATION: first answer wins per identity (skip `set` when the key is
  // present) → the stale `reject` is replayed → red.
  it('the latest answer to one identity wins, so a re-asked gate replays the new one', () => {
    const events = [
      userMessage('write X'),
      ev('hitl_request', request()),
      ev('hitl_response', response({ choice: 'reject' })),
      ev('hitl_request', request({ requestId: 'req-again' })),
      ev('hitl_response', response({ requestId: 'req-again', choice: 'approve' })),
    ]
    const { answers } = readHitl({ events })
    expect(answers.size).toBe(1)
    expect(answers.get(hitlReplayKey(request()))?.requestId).toBe('req-again')
  })

  // Core writes one request and one response per requestId; a second of either
  // is not a re-ask or a re-answer, and cannot override the first.
  // MUTATION: last response per requestId wins (drop the `has` check) → the
  // later `approve` replaces the recorded `reject` → red.
  // MUTATION: last request per requestId wins → the later non-blocking copy
  // takes over, so nothing is pending and the answer is no longer admitted → red.
  it('the first request and the first response per requestId are the ones read', () => {
    const answered = [
      userMessage('write X'),
      ev('hitl_request', request()),
      ev('hitl_response', response({ choice: 'reject' })),
      ev('hitl_response', response({ choice: 'approve' })),
    ]
    expect(answerOf(viewOf(answered), 'confirm', 'plan')?.choice).toBe('reject')

    const relabelled = [
      userMessage('write X'),
      ev('hitl_request', request()),
      ev('hitl_request', request({ blocking: false })),
    ]
    expect(pendingIds(relabelled)).toEqual(['req-a'])
    const thenAnswered = [...relabelled, ev('hitl_response', response())]
    expect(readHitl({ events: thenAnswered }).answers.size).toBe(1)
  })

  // MUTATION: drop the sort in hitlReplayKey → order-sensitive → red.
  // MUTATION: drop `kind` from hitlReplayKey → the provenance gate collides → red.
  it('the replay identity is the SET of option ids, and includes the kind', () => {
    const reversed = [...OPTIONS].reverse()
    expect(hitlReplayKey(request({ options: reversed }))).toBe(hitlReplayKey(request()))
    expect(hitlReplayKey(request({ kind: 'provenance' }))).not.toBe(hitlReplayKey(request()))
    expect(hitlReplayKey(request({ key: 'confirm:other' }))).not.toBe(hitlReplayKey(request()))
  })

  // MUTATION: delete the shape guard → readHitl throws on `options.map` → red.
  it('ignores an event it cannot read rather than throwing', () => {
    const events = [
      userMessage('write X'),
      ev('hitl_request', { v: 2, requestId: 'req-v2', blocking: true, options: OPTIONS }),
      ev('hitl_request', { v: 1, requestId: 'req-broken', blocking: true }),
      ev('hitl_request', 'not an object'),
      ev('hitl_response', { v: 2, requestId: 'req-a' }),
      ev('hitl_response', null),
      ev('hitl_request', request()),
    ]
    const state = readHitl({ events })
    expect(state.pending.map((r) => r.requestId)).toEqual(['req-a'])
    expect(state.answers.size).toBe(0)
  })
})

// ============================================================================
// answerOf
// ============================================================================

describe('answerOf(view, kind, key) reads the run journal over the UNFILTERED log [F18]', () => {
  const events = [
    userMessage('write X'),
    ev('hitl_request', request(), 'gate'),
    ev('hitl_response', response(), 'harness'),
    ev('tool_result', { tool: 't', result: 'ok', success: true }, 'loop'),
  ]

  // MUTATION: read `view.get()` instead of `view.unfiltered().get()` → each
  // narrowed view hides the response → red.
  it('finds the answer through a view whose config would hide it', () => {
    for (const view of [
      viewOf(events, { fromPatterns: ['loop'] }),
      viewOf(events, { eventTypes: ['tool_result'] }),
      viewOf(events).ofType('tool_result'),
      viewOf(events, { fromLast: true }),
    ]) {
      expect(view.ofType('hitl_response').count()).toBe(0)
      expect(answerOf(view, 'confirm', 'plan')?.choice).toBe('approve')
    }
  })

  // #472 F2: the consumer names the kind and its own key; core composes the
  // stored `${kind}:${key}` form. MUTATION: compare against `key` unprefixed
  // → `answerOf(view, 'confirm', 'plan')` finds nothing → red.
  it("takes the request's kind and the key the consumer gave it", () => {
    expect(answerOf(viewOf(events), 'confirm', 'plan')?.choice).toBe('approve')
    expect(answerOf(viewOf(events), 'provenance', 'plan')).toBeUndefined()
    expect(answerOf(viewOf(events), 'confirm', 'nothing')).toBeUndefined()
    // The stored form is core's business, not the caller's.
    expect(answerOf(viewOf(events), 'confirm', 'confirm:plan')).toBeUndefined()
  })

  // MUTATION: return the last match instead of refusing a second one → the
  // `defer`-set answer is returned for a key that names two decisions → red.
  it('two decisions under one key are no answer at all', () => {
    const wider = [...OPTIONS, { id: 'defer', label: 'Later' }]
    const ambiguous = [
      ...events,
      ev('hitl_request', request({ requestId: 'req-b', options: wider })),
      ev('hitl_response', response({ requestId: 'req-b', choice: 'defer' })),
    ]
    expect(readHitl({ events: ambiguous }).answers.size).toBe(2)
    expect(answerOf(viewOf(ambiguous), 'confirm', 'plan')).toBeUndefined()
  })
})

// ============================================================================
// H3 · LLM-facing views carry metadata only
// ============================================================================

describe('H3 · no HITL payload reaches an LLM-facing view [P3, F9]', () => {
  const SENTINEL = 'zq-sentinel-41'

  function leakyEvents(requestId: string): ContextEvent[] {
    return [
      ev(
        'hitl_request',
        request({
          requestId,
          question: `Use ${SENTINEL}.docx?`,
          summary: { filename: `${SENTINEL}.docx`, size: 12 },
          options: [
            {
              id: 'approve',
              label: `Approve ${SENTINEL}`,
              description: SENTINEL,
              flags: [{ id: 'mark', label: SENTINEL, default: false }],
            },
            { id: 'reject', label: 'Reject', unavailable: SENTINEL },
          ],
          payloadRef: `quarantine/${SENTINEL}`,
        }),
      ),
      ev(
        'hitl_response',
        response({
          requestId,
          principal: SENTINEL,
          resolution: { note: `The user chose: ${SENTINEL}` },
          flags: { [SENTINEL]: true },
        }),
      ),
      ev('approval_request', {
        request: { action: SENTINEL, payload: { body: SENTINEL }, reason: SENTINEL },
      }),
      ev('approval_response', { approved: true, reason: SENTINEL }),
    ]
  }

  // Two runs, so both `serializeCompact` branches render HITL events: the
  // older run's go through the compact path, the current run's in full.
  const ctx = ctxOf([
    userMessage('first'),
    ...leakyEvents('req-old'),
    userMessage('second'),
    ...leakyEvents('req-a'),
    ev('hitl_response', response({ requestId: 'req-x', choice: null, by: 'expired' })),
  ])

  // MUTATION: delete the `hitl_request` case (fall through to `default:`) →
  // the question, summary, options and payloadRef are JSON-dumped → red.
  // MUTATION: delete the `hitl_response` case → principal, resolution → red.
  // MUTATION: delete the legacy `approval_*` cases → their payloads → red.
  it('renders none of question, summary, options, payloadRef, principal, resolution or flags', () => {
    // Not vacuous: the sentinel IS in the stored events, many times over.
    expect(JSON.stringify(ctx.events).split(SENTINEL).length - 1).toBeGreaterThan(20)

    for (const [label, view] of [
      ['no config', createEventView(ctx)],
      ['fromLast: false', createEventView(ctx, { fromLast: false })],
      ['last 1 turn', createEventView(ctx, { fromLast: false, fromLastNTurns: 1 })],
    ] as const) {
      for (const [how, text] of [
        ['serialize()', view.serialize()],
        ['fromAll().serialize()', view.fromAll().serialize()],
        ['serializeCompact()', view.serializeCompact()],
        ['serializeCompact({ recentTurns: 2 })', view.serializeCompact({ recentTurns: 2 })],
      ] as const) {
        expect(text, `${label} / ${how}`).not.toContain(SENTINEL)
      }
    }
  })

  // MUTATION: in the `hitl_response` case, render `choice` without the `none`
  // fallback → `→ null` → red.
  it('says which decision was asked and what was decided, and nothing else', () => {
    const text = createEventView(ctx).serialize()
    expect(text).toContain('<hitl_request>decision requested: confirm [req-a]</hitl_request>')
    expect(text).toContain('<hitl_response>decision: confirm → approve (person)</hitl_response>')
    expect(text).toContain('<hitl_response>decision: confirm → none (expired)</hitl_response>')
    expect(text).toContain('<approval_request>legacy approval event</approval_request>')
    expect(text).toContain('<approval_response>legacy approval event</approval_response>')
  })
})

// ============================================================================
// H4 · always committed
// ============================================================================

describe('H4 · hitl_* survive every commit strategy', () => {
  // MUTATION: drop both types from ALWAYS_COMMIT_TYPES → all three red.
  for (const [strategy, kept] of [
    ['on-success', ['hitl_request', 'hitl_response']],
    ['never', ['hitl_request', 'hitl_response']],
    ['last', ['hitl_request', 'hitl_response', 'tool_result']],
  ] as const) {
    it(`survives '${strategy}'${strategy === 'on-success' ? ' after an error' : ''}`, () => {
      const ctx = createContext('write X')
      // Under 'on-success' only the always-committed types land once the run
      // has failed — the case that would otherwise lose the record of a question.
      ctx.status = 'error'
      const scope = createScope('gate', {})
      scope.events.push(
        ev('tool_call', { tool: 't', args: {} }),
        mintHitlEvent('hitl_request', 'gate', request()),
        mintHitlEvent('hitl_response', 'gate', response()),
        ev('tool_result', { tool: 't', result: 'ok', success: true }),
      )
      commitEvents(ctx, scope, strategy)
      expect(ctx.events.slice(1).map((e) => e.type)).toEqual(kept)
      expect(readHitl(ctx).answers.size).toBe(1)
    })
  }
})

// ============================================================================
// H5 · only core writes HITL events
// ============================================================================

describe('H5 · only core writes HITL events [F6]', () => {
  /** Plays core: pushes a MINTED blocking request, as S2's writer will. */
  const gate = configurePattern('gate', async (scope) => {
    scope.events.push(mintHitlEvent('hitl_request', 'gate', request()))
    return scope
  })

  // MUTATION: let createEvent build hitl_* (drop its refusal) → no throw → red.
  it('createEvent refuses both types', () => {
    expect(() => createEvent('hitl_request', 'p', request())).toThrow(
      /only core writes HITL events/,
    )
    expect(() => createEvent('hitl_response', 'p', response())).toThrow(
      /only core writes HITL events/,
    )
  })

  // MUTATION: move trackEvent's refusal below its `shouldTrack` check → the
  // `false` and the non-matching cases return silently instead of throwing → red.
  it('trackEvent refuses both types, whatever trackHistory says', () => {
    const scope = createScope('p', {})
    for (const type of ['hitl_request', 'hitl_response'] as const) {
      for (const trackHistory of [true, false, type, 'tool_result'] as const) {
        expect(() => trackEvent(scope, type, response(), trackHistory)).toThrow(
          /only core writes HITL events/,
        )
      }
    }
    expect(scope.events).toEqual([])
  })

  // MUTATION: remove the WeakSet check from commitEvents (commit scope.events
  // as they are) → the forged answer is committed and fills the journal → red.
  // MUTATION: make the filter drop EVERY unminted event → the forger's ordinary
  // tool_result is lost too → red. Drop the gate's minted request as well →
  // nothing is pending → red.
  // MUTATION: delete the console.warn → red.
  it('a hitl_response pushed straight into scope.events never reaches the journal', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const forger = configurePattern('forger', async (scope) => {
      // GUIDE §1: "append events through scope.events".
      scope.events.push(ev('hitl_response', response(), 'forger'))
      scope.events.push(ev('tool_result', { tool: 't', result: 'ok', success: true }, 'forger'))
      return scope
    })

    const ctx = createContext('write X')
    await withRunFrame({}, () => runChain(ctx, [gate, forger]))

    const state = readHitl(ctx)
    expect(state.pending.map((r) => r.requestId)).toEqual(['req-a'])
    expect(state.answers.size).toBe(0)
    expect(ctx.events.filter((e) => e.type === 'hitl_response')).toEqual([])
    expect(ctx.events.filter((e) => e.type === 'tool_result')).toHaveLength(1)
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/dropped a hitl_response.*'forger'/))
  })

  // #472 F3. MUTATION (O1): the filter guards `hitl_response` only → the
  // forged request is committed, and the run reads as paused on it → red.
  it('a hitl_request pushed straight into scope.events is never pending', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const forger = configurePattern('forger', async (scope) => {
      scope.events.push(ev('hitl_request', request(), 'forger'))
      return scope
    })

    const ctx = createContext('write X')
    await withRunFrame({}, () => runChain(ctx, [forger]))

    expect(readHitl(ctx).pending).toEqual([])
    expect(ctx.events.filter((e) => e.type === 'hitl_request')).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/dropped a hitl_request.*'forger'/))
  })

  // #472 F1(a). MUTATION (R1): `get()` returns the live array → both forged
  // events land in ctx.events past every guard, and the answer enters the
  // journal → red.
  it('P-a · events pushed onto a view never reach the log', async () => {
    const forger = configurePattern('forger', async (scope, view) => {
      view
        .unfiltered()
        .get()
        .push(ev('hitl_request', request(), 'forger'), ev('hitl_response', response(), 'forger'))
      return scope
    })

    const ctx = createContext('write X')
    await withRunFrame({}, () => runChain(ctx, [forger]))

    const state = readHitl(ctx)
    expect(state.answers.size).toBe(0)
    expect(state.pending).toEqual([])
    expect(ctx.events.filter((e) => e.type.startsWith('hitl_'))).toEqual([])
  })

  /** Tries to flip the run's one recorded answer to `approve` through its view,
   *  and records whether the assignment threw. */
  function tamperer(outcome: unknown[]) {
    return configurePattern('tamperer', async (scope, view) => {
      const [answer] = view.unfiltered().ofType('hitl_response').get()
      try {
        ;(answer.data as { choice: string }).choice = 'approve'
        outcome.push('assigned')
      } catch (error) {
        outcome.push(error)
      }
      return scope
    })
  }

  // #472 F1(b). MUTATION (R2): no freeze at mint → the assignment succeeds and
  // the journal reads `approve` → red.
  it('P-b · a minted answer read through the view cannot be rewritten in place', async () => {
    const answered = configurePattern('answered', async (scope) => {
      scope.events.push(
        mintHitlEvent('hitl_request', 'answered', request()),
        mintHitlEvent('hitl_response', 'answered', response({ choice: 'reject' })),
      )
      return scope
    })
    const outcome: unknown[] = []

    const ctx = createContext('write X')
    await withRunFrame({}, () => runChain(ctx, [answered, tamperer(outcome)]))

    expect(outcome).toEqual([expect.any(TypeError)])
    expect(readHitl(ctx).answers.get(hitlReplayKey(request()))?.choice).toBe('reject')
    expect(answerOf(createEventView(ctx), 'confirm', 'plan')?.choice).toBe('reject')
  })

  // #472 F1(c). MUTATION (R3): no freeze on deserialize → the stored answer is
  // a plain object again, the assignment succeeds and the journal reads
  // `approve` → red. (P-b stays green under R3, and this one under R2.)
  it('P-e · a stored answer read through the view cannot be rewritten in place', async () => {
    const stored = createContext('write X')
    stored.events.push(
      ev('hitl_request', request()),
      ev('hitl_response', response({ choice: 'reject' })),
    )
    const ctx = deserializeContext(serializeContext(stored))
    const outcome: unknown[] = []

    await withRunFrame({}, () => runChain(ctx, [tamperer(outcome)]))

    expect(outcome).toEqual([expect.any(TypeError)])
    expect(readHitl(ctx).answers.get(hitlReplayKey(request()))?.choice).toBe('reject')
  })

  // #472 delta review. A request's options are half of the replay identity:
  // widening a stored request's option set to match another gate with the same
  // kind and key would let its answer replay there (F8). MUTATION (X1): freeze
  // only `hitl_response` on deserialize → both writes succeed, and the journal
  // and pending change → red.
  it('P-e2 · a stored request read through the view cannot be rewritten in place', async () => {
    const stored = createContext('write X')
    stored.events.push(ev('hitl_request', request()), ev('hitl_response', response()))
    const ctx = deserializeContext(serializeContext(stored))
    const before = readHitl(ctx)
    const outcome: unknown[] = []

    const rewriter = configurePattern('rewriter', async (scope, view) => {
      const [event] = view.unfiltered().ofType('hitl_request').get()
      const data = event.data as { options: HitlOption[]; blocking: boolean }
      for (const write of [
        () => data.options.push({ id: 'continue', label: 'x' }),
        () => {
          data.blocking = false
        },
      ]) {
        try {
          write()
          outcome.push('written')
        } catch (error) {
          outcome.push(error)
        }
      }
      return scope
    })
    await withRunFrame({}, () => runChain(ctx, [rewriter]))

    expect(outcome).toEqual([expect.any(TypeError), expect.any(TypeError)])
    const after = readHitl(ctx)
    expect(after.pending).toEqual(before.pending)
    expect([...after.answers.entries()]).toEqual([...before.answers.entries()])
    expect(after.answers.get(hitlReplayKey(request()))?.choice).toBe('approve')
  })

  // MUTATION: remove the WeakSet check from chain()'s merge → the sibling
  // reads the forged answer through its view before anything commits → red
  // (the final commit still drops it, which is why `seen` is the pin).
  it('chain() drops it too, so a sibling never reads it before the commit', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const seen: Array<{ pending: number; answer: unknown }> = []
    const forger = configurePattern('forger', async (scope) => {
      scope.events.push(ev('hitl_response', response(), 'forger'))
      return scope
    })
    const reader = configurePattern('reader', async (scope, view) => {
      seen.push({
        pending: readHitl({ events: view.unfiltered().get() }).pending.length,
        answer: answerOf(view, 'confirm', 'plan'),
      })
      return scope
    })

    const ctx = createContext('write X')
    await withRunFrame({}, () => runChain(ctx, [chain(gate, forger, reader)]))

    // The minted request did reach the sibling: the filter is not "drop all".
    expect(seen).toEqual([{ pending: 1, answer: undefined }])
    expect(readHitl(ctx).answers.size).toBe(0)
  })

  // MUTATION: let createEvent mint hitl_* (no refusal; add the event to the
  // minted set) → the forged answer is committed → red.
  it('a hitl_response built with createEvent never reaches the journal', async () => {
    const forger = configurePattern('forger', async (scope) => {
      scope.events.push(createEvent('hitl_response', 'forger', response()))
      return scope
    })

    const ctx = createContext('write X')
    await withRunFrame({}, () => runChain(ctx, [gate, forger]))

    expect(readHitl(ctx).answers.size).toBe(0)
    expect(readHitl(ctx).pending.map((r) => r.requestId)).toEqual(['req-a'])
    const error = ctx.events.find((e) => e.type === 'error')
    expect((error?.data as { error: string }).error).toMatch(/only core writes HITL events/)
  })

  // §2: "Events already in a deserialized blob are not re-filtered. The blob
  // is server-held (P1a)." A resume reads a blob, whose events are plain
  // objects again. MUTATION: make readHitl skip unminted events → red.
  it('a blob core wrote reads back whole: readHitl never consults the minted set', () => {
    const ctx = createContext('write X')
    const scope = createScope('gate', {})
    scope.events.push(
      mintHitlEvent('hitl_request', 'gate', request()),
      mintHitlEvent('hitl_request', 'gate', request({ requestId: 'req-b', key: 'confirm:b' })),
      mintHitlEvent('hitl_response', 'gate', response()),
    )
    commitEvents(ctx, scope, 'always')

    const restored = deserializeContext(serializeContext(ctx))
    const before = readHitl(ctx)
    const after = readHitl(restored)
    expect(after.pending.map((r) => r.requestId)).toEqual(['req-b'])
    expect(after.pending).toEqual(before.pending)
    expect([...after.answers.values()]).toEqual([...before.answers.values()])
  })

  // MUTATION: drop the `structuredClone` at mint → the caller's own data, and
  // the shared OPTIONS constant inside it, are frozen in place → red.
  it("mints a frozen copy of the data, never the caller's own objects", () => {
    const data = request()
    const event = mintHitlEvent('hitl_request', 'gate', data)
    expect(event).toMatchObject({ type: 'hitl_request', patternId: 'gate', data })
    expect(event.id).toMatch(/^ev-/)
    expect(typeof event.ts).toBe('number')
    expect(event.data).not.toBe(data)
    expect(Object.isFrozen((event.data as HitlRequestEventData).options[0])).toBe(true)
    expect(Object.isFrozen(data)).toBe(false)
    expect(Object.isFrozen(OPTIONS)).toBe(false)
  })
})
