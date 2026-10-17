/**
 * #433 S11 / #419 M6, core half: `proposeToHuman`, `answerProposal`,
 * `readProposals`.
 *
 * A proposal is a request raised from OUTSIDE a run (a post-reply hook), so it
 * is non-blocking and lives in the context as two events like any decision.
 * What these pins hold is the binding: an answer reaches exactly the proposal
 * it was issued for, once, within its window, with a choice that proposal
 * offered — and a refusal leaves the blob untouched.
 *
 * Every pin names the source mutation that turns it red; each one was run (see
 * the PR's pin/mutation table).
 *
 *   PR1  a proposal is non-blocking: recorded, never pending, no resume point
 *   PR2  replay: one proposal per identity; answered/expired is not re-raised
 *   PR3  a proposal outlives the turn: the next message does not close it
 *   PR4  an answer binds to an OPEN proposal: not a pause, not twice, not made up
 *   PR5  the option checks a resume applies
 *   PR6  past due is `expired`
 *   PR7  recording: person, host principal, flags; all-or-nothing
 *   PR8  nobody there: `park` waits, a pickable option decides, nothing pickable is null
 *   PR9  validation at raise names the function that raised
 */

import { describe, expect, it } from 'vitest'
import {
  answerProposal,
  HitlAnswerError,
  HitlRequestError,
  proposeToHuman,
  readHitl,
  readProposals,
  expireHitl,
} from '../hitl.server'
import { createContext, createEvent, mintHitlEvent, serializeContext } from '../context.server'
import type { HitlRequest, HitlRequestEventData, UnifiedContext } from '../types'

// ============================================================================
// Fixtures — synthetic throughout
// ============================================================================

const request = (over: Partial<HitlRequest> = {}): HitlRequest => ({
  kind: 'memory.confirm',
  key: 'ev-1',
  question: 'Save these to memory?',
  options: [
    {
      id: 'save',
      label: 'Save selected',
      flags: [
        { id: 'i0', label: 'Item 1', default: true },
        { id: 'i1', label: 'Item 2', default: true },
      ],
    },
    { id: 'discard', label: "Don't save", unattended: true },
  ],
  defaultOption: 'save',
  summary: { items: 2 },
  unattended: 'park',
  expiresInMs: 60_000,
  ...over,
})

const turn = (): UnifiedContext => {
  const ctx = createContext('I prefer metric units')
  ctx.events.push(createEvent('assistant_message', 'x', { content: 'Noted.', final: true }))
  return ctx
}

const requestsIn = (ctx: UnifiedContext): HitlRequestEventData[] =>
  ctx.events.filter((e) => e.type === 'hitl_request').map((e) => e.data as HitlRequestEventData)

const responsesIn = (ctx: UnifiedContext) =>
  ctx.events.filter((e) => e.type === 'hitl_response').map((e) => e.data as Record<string, unknown>)

const propose = (ctx: UnifiedContext, over: Partial<HitlRequest> = {}) =>
  proposeToHuman(ctx, request(over), { attended: true, patternId: 'memory-store' })

/** A refusal as the error it is, or the test fails. */
function refusal(fn: () => unknown): HitlAnswerError {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(HitlAnswerError)
    return e as HitlAnswerError
  }
  throw new Error('expected a refusal')
}

// ============================================================================
// PR1
// ============================================================================

describe('PR1 · a proposal is non-blocking', () => {
  // MUTATION: `blocking: true` → pending lists it, a resume would wait on it → red.
  it('records one request event that no run waits on', () => {
    const ctx = turn()
    const out = propose(ctx)
    expect(out.status).toBe('pending')
    const [r] = requestsIn(ctx)
    expect(r).toMatchObject({
      v: 1,
      kind: 'memory.confirm',
      key: 'memory.confirm:ev-1',
      blocking: false,
      unattended: 'park',
    })
    expect(r.resumeAt).toBeUndefined()
    expect(r.expiresAt).toBeGreaterThan(Date.now())
    expect(out.requestId).toBe(r.requestId)
    expect(ctx.status).toBe('running')
    expect(readHitl(ctx).pending).toEqual([])
    expect(readProposals(ctx).map((p) => p.requestId)).toEqual([r.requestId])
  })

  // MUTATION: `randomUUID()` → `generateId()` makes the id short and guessable → red.
  it('the request id is a UUID v4', () => {
    const ctx = turn()
    const { requestId } = propose(ctx)
    expect(requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })
})

// ============================================================================
// PR2
// ============================================================================

describe('PR2 · replay: one proposal per identity', () => {
  // MUTATION: drop the identity scan → a second event is raised → red.
  it('the same proposal twice is one request, and the second call says pending', () => {
    const ctx = turn()
    const first = propose(ctx)
    const second = propose(ctx)
    expect(requestsIn(ctx)).toHaveLength(1)
    expect(second).toEqual({ status: 'pending', requestId: first.requestId })
  })

  // MUTATION: only look for OPEN proposals → an answered one is raised again,
  // and the person is asked twice about one turn → red.
  it('an answered proposal is returned as answered and not raised again', () => {
    const ctx = turn()
    const { requestId } = propose(ctx)
    answerProposal(ctx, { [requestId]: { choice: 'save', flags: { i0: true, i1: false } } })
    const again = propose(ctx)
    expect(requestsIn(ctx)).toHaveLength(1)
    expect(again).toMatchObject({
      status: 'answered',
      requestId,
      choice: 'save',
      by: 'person',
      flags: { i0: true, i1: false },
    })
  })

  // MUTATION: re-raise on `choice: null` → a declined-by-expiry proposal returns → red.
  it('an expired proposal stays closed for its identity', () => {
    const ctx = turn()
    const { requestId } = propose(ctx)
    const out = expireHitl(serializeContext(ctx), Date.now() + 120_000)!
    const after = JSON.parse(out.serialized) as UnifiedContext
    const again = propose(after)
    expect(requestsIn(after)).toHaveLength(1)
    expect(again).toMatchObject({ status: 'answered', requestId, choice: null, by: 'expired' })
  })

  // MUTATION: key by kind alone → two different turns share one proposal → red.
  it('two turns are two proposals', () => {
    const ctx = turn()
    const a = propose(ctx, { key: 'ev-1' })
    const b = propose(ctx, { key: 'ev-2' })
    expect(a.requestId).not.toBe(b.requestId)
    expect(requestsIn(ctx)).toHaveLength(2)
  })
})

// ============================================================================
// PR3
// ============================================================================

describe('PR3 · a proposal outlives the turn that raised it', () => {
  // MUTATION: window `readProposals` from the last `user_message` → the open
  // proposal disappears when the person sends their next message → red.
  it('a later user message does not close it, and it is still answerable', () => {
    const ctx = turn()
    const { requestId } = propose(ctx)
    ctx.events.push(createEvent('user_message', 'harness', { content: 'next question' }))
    ctx.events.push(createEvent('assistant_message', 'x', { content: 'Sure.', final: true }))
    expect(readHitl(ctx).pending).toEqual([])
    expect(readProposals(ctx).map((p) => p.requestId)).toEqual([requestId])
    expect(answerProposal(ctx, { [requestId]: 'discard' })).toHaveLength(1)
    expect(readProposals(ctx)).toEqual([])
  })

  // MUTATION: ignore `now` → an expired proposal is listed as open → red.
  it('readProposals(now) leaves out one past due', () => {
    const ctx = turn()
    propose(ctx, { expiresInMs: 1_000 })
    expect(readProposals(ctx, Date.now())).toHaveLength(1)
    expect(readProposals(ctx, Date.now() + 5_000)).toHaveLength(0)
  })
})

// ============================================================================
// PR4
// ============================================================================

describe('PR4 · an answer binds to an open proposal', () => {
  // MUTATION: look the id up among ALL requests → an answer to a pause is
  // recorded without resuming it → red.
  it('a BLOCKING request is not a proposal', () => {
    const ctx = turn()
    const blocking = mintHitlEvent('hitl_request', 'gate', {
      v: 1,
      requestId: '11111111-1111-4111-8111-111111111111',
      runId: ctx.events[0].id ?? '',
      key: 'confirm:gate',
      kind: 'confirm',
      question: 'Go on?',
      options: [
        { id: 'approve', label: 'Approve' },
        { id: 'reject', label: 'Reject' },
      ],
      defaultOption: 'reject',
      unattended: 'apply-default',
      summary: {},
      blocking: true,
      resumeAt: { index: 0, names: ['gate'] },
    })
    ctx.events.push(blocking)
    const before = serializeContext(ctx)
    expect(
      refusal(() => answerProposal(ctx, { '11111111-1111-4111-8111-111111111111': 'approve' }))
        .code,
    ).toBe('unknown-request')
    expect(serializeContext(ctx)).toBe(before)
  })

  // MUTATION: check the journal instead of the open set → a second answer is
  // recorded → red.
  it('a second answer to the same proposal is refused and changes nothing', () => {
    const ctx = turn()
    const { requestId } = propose(ctx)
    answerProposal(ctx, { [requestId]: 'discard' })
    const before = serializeContext(ctx)
    expect(refusal(() => answerProposal(ctx, { [requestId]: 'save' })).code).toBe('unknown-request')
    expect(serializeContext(ctx)).toBe(before)
    expect(responsesIn(ctx)).toHaveLength(1)
  })

  it('an id nobody raised is refused, including the ones an object prototype has', () => {
    const ctx = turn()
    propose(ctx)
    const before = serializeContext(ctx)
    for (const id of ['nope', '__proto__', 'constructor']) {
      expect(refusal(() => answerProposal(ctx, { [id]: 'save' })).code).toBe('unknown-request')
    }
    expect(serializeContext(ctx)).toBe(before)
  })

  // MUTATION: treat an empty answer map as "nothing to record, fine" → red.
  it('an answer that answers nothing is refused', () => {
    const ctx = turn()
    propose(ctx)
    expect(refusal(() => answerProposal(ctx, {})).code).toBe('missing-answer')
  })

  it('the refusal never quotes what the caller sent', () => {
    const ctx = turn()
    propose(ctx)
    const e = refusal(() => answerProposal(ctx, { 'SENTINEL-ID<script>': 'save' }))
    expect(e.message).not.toContain('SENTINEL')
    expect(e.message).toContain('answerProposal refused')
  })
})

// ============================================================================
// PR5
// ============================================================================

describe('PR5 · the checks a resume applies', () => {
  const open = () => {
    const ctx = turn()
    const { requestId } = propose(ctx, {
      options: [
        {
          id: 'save',
          label: 'Save selected',
          flags: [
            { id: 'i0', label: 'Item 1', default: true },
            { id: 'sure', label: 'Sure', default: false, required: true },
          ],
        },
        { id: 'later', label: 'Later', unavailable: 'not yet' },
        { id: 'discard', label: "Don't save", unattended: true },
      ],
    })
    return { ctx, requestId }
  }

  // MUTATION (one per row): drop the corresponding check in `checkChoice`.
  it.each([
    ['a choice that is not an option', 'nuke', 'invalid-choice'],
    ['an unavailable option', 'later', 'unavailable-option'],
    ['an undeclared flag', { choice: 'discard', flags: { extra: true } }, 'invalid-flag'],
    ['a non-boolean flag', { choice: 'save', flags: { i0: 'yes', sure: true } }, 'invalid-flag'],
    ['a required flag left out', { choice: 'save', flags: { i0: true } }, 'required-flag'],
    ['a required flag left to its default', { choice: 'save' }, 'required-flag'],
  ])('%s is refused (%s)', (_name, answer, code) => {
    const { ctx, requestId } = open()
    const before = serializeContext(ctx)
    expect(refusal(() => answerProposal(ctx, { [requestId]: answer as never })).code).toBe(code)
    expect(serializeContext(ctx)).toBe(before)
  })

  it('a valid answer to the same request is accepted', () => {
    const { ctx, requestId } = open()
    const [done] = answerProposal(ctx, {
      [requestId]: { choice: 'save', flags: { i0: false, sure: true } },
    })
    expect(done.choice).toBe('save')
    expect(done.flags).toEqual({ i0: false, sure: true })
  })
})

// ============================================================================
// PR6
// ============================================================================

describe('PR6 · past due is expired', () => {
  // MUTATION: drop the `pastDue` check → an answer lands on a proposal the
  // sweep already purged the payload of → red.
  it('refuses an answer once the proposal is past due, and leaves it open for expireHitl', () => {
    const ctx = turn()
    const { requestId } = propose(ctx, { expiresInMs: 1_000 })
    const before = serializeContext(ctx)
    const e = refusal(() =>
      answerProposal(ctx, { [requestId]: 'save' }, { now: Date.now() + 5_000 }),
    )
    expect(e.code).toBe('expired')
    expect(e.requestId).toBe(requestId)
    expect(serializeContext(ctx)).toBe(before)
  })
})

// ============================================================================
// PR7
// ============================================================================

describe('PR7 · recording', () => {
  // MUTATION: take `principal` from the answer → a client names itself → red;
  // mutation 2: `by: 'unattended'` → red.
  it('records by "person" with the host-stamped principal, and nothing from the answer', () => {
    const ctx = turn()
    const { requestId } = propose(ctx)
    answerProposal(
      ctx,
      {
        [requestId]: {
          choice: 'save',
          flags: { i0: true, i1: false },
          principal: 'mallory',
        } as never,
      },
      { principal: 'user-1' },
    )
    expect(responsesIn(ctx)).toEqual([
      {
        v: 1,
        requestId,
        key: 'memory.confirm:ev-1',
        kind: 'memory.confirm',
        choice: 'save',
        flags: { i0: true, i1: false },
        by: 'person',
        principal: 'user-1',
      },
    ])
  })

  // MUTATION: push each response as it validates → the first lands although the
  // second is refused → red.
  it('is all-or-nothing across several answers', () => {
    const ctx = turn()
    const a = propose(ctx, { key: 'ev-1' })
    const b = propose(ctx, { key: 'ev-2' })
    const before = serializeContext(ctx)
    expect(
      refusal(() => answerProposal(ctx, { [a.requestId]: 'save', [b.requestId]: 'nuke' })).code,
    ).toBe('invalid-choice')
    expect(serializeContext(ctx)).toBe(before)
    answerProposal(ctx, { [a.requestId]: 'discard' })
    expect(readProposals(ctx).map((p) => p.requestId)).toEqual([b.requestId])
  })

  // MUTATION: omit the `flags` on a flagged option → the host cannot tell
  // which items were chosen → red.
  it('keeps the flags of the chosen option, and none for an option with none', () => {
    const ctx = turn()
    const a = propose(ctx)
    const [saved] = answerProposal(ctx, { [a.requestId]: { choice: 'save', flags: { i1: false } } })
    expect(saved.flags).toEqual({ i0: true, i1: false })
    const b = propose(ctx, { key: 'ev-2' })
    answerProposal(ctx, { [b.requestId]: 'discard' })
    expect(responsesIn(ctx)[1]).not.toHaveProperty('flags')
  })

  it('the events are frozen: a holder cannot rewrite the decision in place', () => {
    const ctx = turn()
    propose(ctx)
    const event = ctx.events.find((e) => e.type === 'hitl_request')!
    expect(Object.isFrozen(event)).toBe(true)
    expect(Object.isFrozen(event.data)).toBe(true)
  })
})

// ============================================================================
// PR8
// ============================================================================

describe('PR8 · nobody there', () => {
  // MUTATION: apply the rule to `park` → the proposal is decided for a person → red.
  it('`park` waits for a person even when unattended', () => {
    const ctx = turn()
    const out = proposeToHuman(ctx, request({ unattended: 'park' }), { attended: false })
    expect(out.status).toBe('pending')
    expect(responsesIn(ctx)).toEqual([])
  })

  // MUTATION: pick the default option unconditionally → `save` is chosen
  // without a person → red.
  it('another rule applies only an option that says it may be picked', () => {
    const ctx = turn()
    const out = proposeToHuman(ctx, request({ unattended: 'apply-default' }), { attended: false })
    expect(out).toMatchObject({ status: 'answered', choice: 'discard', by: 'unattended' })
    expect(responsesIn(ctx)).toEqual([
      expect.objectContaining({ choice: 'discard', by: 'unattended' }),
    ])
  })

  it('with nothing pickable the answer is null, never an option nobody chose', () => {
    const ctx = turn()
    const out = proposeToHuman(
      ctx,
      request({
        unattended: 'apply-default',
        options: [
          { id: 'save', label: 'Save' },
          { id: 'discard', label: 'Discard' },
        ],
      }),
      { attended: false },
    )
    expect(out).toMatchObject({ status: 'answered', choice: null, by: 'unattended' })
  })
})

// ============================================================================
// PR9
// ============================================================================

describe('PR9 · validation at raise', () => {
  // MUTATION: skip `validate` → an unanswerable request is recorded → red.
  it('an invalid request throws and records nothing, naming proposeToHuman', () => {
    const ctx = turn()
    const n = ctx.events.length
    expect(() => propose(ctx, { options: [{ id: 'only', label: 'Only' }] })).toThrow(
      HitlRequestError,
    )
    expect(() => propose(ctx, { kind: 'a:b' })).toThrow(/^proposeToHuman:/)
    expect(() => propose(ctx, { defaultOption: 'nope' })).toThrow(/defaultOption/)
    expect(ctx.events).toHaveLength(n)
  })
})
