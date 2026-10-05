/**
 * DX (#433, slice S4): the ergonomic surface over the mechanism.
 *
 * The owner's rule (O5): the pattern should make DX as ergonomic as possible —
 * the common case is one call with sensible defaults, and the custom case is
 * discoverable. This slice adds:
 *
 * - `confirm(config)` — the one-call gate at a chain boundary: Reject is the
 *   default, is what the unattended rule picks, and stops the run; Approve
 *   needs a person, always.
 * - `humanGate({ request, onAnswer })` — the custom case, the same shape with
 *   the consumer's own request.
 * - `agent.resume(...)` / `agent.continue(...)` — the bound forms of
 *   `resumeHarness` / `continueSession`, carrying the runner's own patterns.
 * - `HarnessResultScoped` as a union on status [F18]: `pending` is
 *   non-optional when the run paused, so the two-request consumer never
 *   reaches for `!`.
 *
 * Pins (spec §8):
 *
 *   H30   confirm: Reject by default, picked unattended, and Approve needs a
 *         person.
 *   H31   agent.resume and agent.continue are bound to the runner's patterns,
 *         and `pending` is typed non-optional when paused.
 *   H32   the GUIDE's two-request snippet compiles. Enforced by the app
 *         suite's guide-docs-pins test, which extracts every `typescript`
 *         fence from GUIDE.md and compiles it against the package's real
 *         exports inside the suite — the mutations for this pin are run
 *         there (see the PR's mutation table).
 *
 * Every pin names the source mutation that turns it red; each one was run.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { harness, type HarnessResultScoped } from '../harness.server'
import { confirm, humanGate } from '../hitl.server'
import { configurePattern } from '../patterns/chain.server'
import type { RunFrame } from '../run-frame.server'
import type { ConfiguredPattern, HitlRequestEventData, HitlResponseEventData } from '../types'

// ============================================================================
// Fixtures — synthetic throughout
// ============================================================================

type Data = { response?: string; [key: string]: unknown }

const ATTENDED: RunFrame = { hitl: { attended: true } }
const UNATTENDED: RunFrame = { hitl: { attended: false } }

/** A pattern that records that it ran — the "downstream" every stop must skip. */
function marker(ran: string[], name: string): ConfiguredPattern<Data> {
  return configurePattern<Data>(name, async (scope) => {
    ran.push(name)
    scope.data = { ...scope.data, response: `answered by ${name}` }
    return scope
  })
}

const requests = (ctx: { events: { type: string; data: unknown }[] }): HitlRequestEventData[] =>
  ctx.events.filter((e) => e.type === 'hitl_request').map((e) => e.data as HitlRequestEventData)
const responses = (ctx: { events: { type: string; data: unknown }[] }): HitlResponseEventData[] =>
  ctx.events.filter((e) => e.type === 'hitl_response').map((e) => e.data as HitlResponseEventData)

/** Narrow to the paused branch the way a consumer must: control flow, no `!`.
 *  With the union in place `result.pending` below typechecks as non-optional;
 *  this file is covered by `pnpm typecheck`. */
function pausedPending(result: HarnessResultScoped<Data>): readonly HitlRequestEventData[] {
  if (result.status !== 'paused') throw new Error(`expected paused, got ${result.status}`)
  const pending: readonly HitlRequestEventData[] = result.pending
  return pending
}

afterEach(() => {
  vi.restoreAllMocks()
})

// ============================================================================
// H30 · confirm: Reject by default, picked unattended, Approve needs a person
// ============================================================================

describe('H30 · confirm: Reject by default, picked unattended, and Approve needs a person', () => {
  // MUTATION (M-H30-approve): mark the approve option `unattended: true` → the
  // unattended run records 'approve' → red. (M-H30-reject: drop reject's
  // `unattended: true` → the rule finds nothing it may pick and records a null
  // choice → red. M-H30-stop: drop reject's `stopsRun` → the run continues
  // past the gate → red.)
  it('an unattended run records Reject and stops there; nothing downstream runs', async () => {
    const ran: string[] = []
    const agent = harness<Data>(
      confirm<Data>({ question: 'Run this plan?', key: 'plan' }),
      marker(ran, 'after'),
    )
    const result = await agent('go', undefined, undefined, undefined, UNATTENDED)

    expect(result.status).toBe('done')
    expect(ran).toEqual([])
    expect(result.response).toContain('confirm check')

    const raised = requests(result.context)
    expect(raised).toHaveLength(1)
    expect(raised[0].kind).toBe('confirm')
    expect(raised[0].key).toBe('confirm:plan')
    expect(raised[0].defaultOption).toBe('reject')
    const options = Object.fromEntries(raised[0].options.map((o) => [o.id, o]))
    expect(options.approve.unattended).toBeUndefined() // Approve needs a person
    expect(options.reject.unattended).toBe(true)
    expect(options.reject.stopsRun).toBe(true)

    const recorded = responses(result.context)
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({ kind: 'confirm', choice: 'reject', by: 'unattended' })
  })

  // MUTATION (M-H31-resume): .resume drops the bound patterns → chain-changed → red.
  it('an attended run pauses, and approving continues with a person’s decision', async () => {
    const ran: string[] = []
    // No frame argument: the DX path — harness() opens the frame and defaults
    // the slot to attended (#433 F7).
    const agent = harness<Data>(
      confirm<Data>({ question: 'Run this plan?', key: 'plan' }),
      marker(ran, 'after'),
    )
    const result = await agent('go')

    expect(result.status).toBe('paused')
    const pending = pausedPending(result) // F18: non-optional when paused
    expect(pending).toHaveLength(1)
    const requestId = pending[0].requestId

    const next = await agent.resume(result.serialized, { [requestId]: 'approve' })
    // A completed chain leaves 'running' (the host maps it to done); 'done'
    // is reserved for an explicit stop.
    expect(next.status).toBe('running')
    expect(ran).toEqual(['after'])
    expect(responses(next.context)).toEqual([
      expect.objectContaining({ kind: 'confirm', choice: 'approve', by: 'person' }),
    ])
  })

  it('a rejection ends the run with nothing re-entered', async () => {
    const ran: string[] = []
    const agent = harness<Data>(
      confirm<Data>({ question: 'Run this plan?', key: 'plan' }),
      marker(ran, 'after'),
    )
    const result = await agent('go', undefined, undefined, undefined, ATTENDED)
    if (result.status !== 'paused') throw new Error('expected paused')
    const requestId = result.pending[0].requestId

    const next = await agent.resume(result.serialized, { [requestId]: 'reject' })
    expect(next.status).toBe('done')
    expect(ran).toEqual([])
    expect(next.response).toContain('Stopped at your request')
  })

  // MUTATION (M-H30-stop): drop reject's `stopsRun` (the onReject default) →
  // the unattended run continues past the gate → red.
  it("onReject: 'continue' lets the run go on instead of stopping", async () => {
    const ran: string[] = []
    const agent = harness<Data>(
      confirm<Data>({ question: 'Run this plan?', onReject: 'continue' }),
      marker(ran, 'after'),
    )
    const result = await agent('go', undefined, undefined, undefined, UNATTENDED)

    expect(result.status).toBe('running')
    expect(ran).toEqual(['after'])
    expect(result.response).toBe('answered by after')
    expect(responses(result.context)).toEqual([
      expect.objectContaining({ kind: 'confirm', choice: 'reject', by: 'unattended' }),
    ])
  })

  it('carries the consumer’s labels and computed question', async () => {
    const agent = harness<Data>(
      confirm<Data>({
        question: (d) => `Ship ${String(d.topic)}?`,
        approveLabel: 'Ship it',
        rejectLabel: 'Hold',
        summary: (d) => ({ topic: String(d.topic) }),
      }),
    )
    const result = await agent('go', undefined, { topic: 'the report' }, undefined, ATTENDED)
    expect(result.status).toBe('paused')

    const raised = requests(result.context)
    expect(raised[0].question).toBe('Ship the report?')
    expect(raised[0].summary).toEqual({ topic: 'the report' })
    const labels = raised[0].options.map((o) => o.label)
    expect(labels).toEqual(['Ship it', 'Hold'])
  })
})

// ============================================================================
// H31 · .resume / .continue are bound to the runner's patterns
// ============================================================================

describe('H31 · agent.resume and agent.continue are bound to the runner’s patterns', () => {
  // MUTATION (M-H31-resume): .resume drops the bound patterns → every resume
  // is refused chain-changed, whatever agent it is called on → both this test
  // and the approval test above are red.
  it('another agent’s chain is refused; the runner’s own chain resumes', async () => {
    const agent = harness<Data>(
      confirm<Data>({ question: 'Run this plan?', key: 'plan' }),
      marker([], 'after'),
    )
    const paused = await agent('go', undefined, undefined, undefined, ATTENDED)
    if (paused.status !== 'paused') throw new Error('expected paused')
    const requestId = paused.pending[0].requestId

    const other = harness<Data>(marker([], 'b1'), marker([], 'b2'))
    await expect(other.resume(paused.serialized, { [requestId]: 'approve' })).rejects.toMatchObject(
      { code: 'chain-changed' },
    )

    const next = await agent.resume(paused.serialized, { [requestId]: 'approve' })
    expect(next.status).toBe('running')
  })

  // MUTATION (M-H31-continue): .continue drops the bound patterns → nothing
  // runs → red.
  it('.continue carries the same patterns', async () => {
    const ran: string[] = []
    const agent = harness<Data>(marker(ran, 'first'), marker(ran, 'second'))
    const first = await agent('go')
    expect(first.status).toBe('running')

    const next = await agent.continue(first.serialized, 'again')
    expect(next.status).toBe('running')
    expect(next.response).toBe('answered by second')
    expect(ran).toEqual(['first', 'second', 'first', 'second'])
  })

  it('.continue on a paused run supersedes what it waits on, and asks again', async () => {
    const agent = harness<Data>(confirm<Data>({ question: 'Run this plan?', key: 'plan' }))
    const paused = await agent('go', undefined, undefined, undefined, ATTENDED)
    if (paused.status !== 'paused') throw new Error('expected paused')
    const oldRequestId = paused.pending[0].requestId

    const next = await agent.continue(paused.serialized, 'forget it')
    // The old decision is closed, nobody chose (P4), and the gate asks again
    // — a NEW request — for the new turn.
    expect(next.status).toBe('paused')
    expect(responses(next.context)).toEqual([
      expect.objectContaining({ requestId: oldRequestId, choice: null, by: 'superseded' }),
    ])
    const raised = requests(next.context)
    expect(raised).toHaveLength(2)
    const newRequestId = raised.map((r) => r.requestId).find((id) => id !== oldRequestId)
    expect(newRequestId).toBeDefined()
    if (next.status !== 'paused') throw new Error('expected paused')
    expect(next.pending[0].requestId).toBe(newRequestId)
  })
})

// ============================================================================
// humanGate · the custom case
// ============================================================================

describe('humanGate · the custom case', () => {
  it('a null request passes through without raising', async () => {
    const agent = harness<Data>(humanGate<Data>({ request: () => null }), marker([], 'after'))
    const result = await agent('go', undefined, undefined, undefined, ATTENDED)
    expect(result.status).toBe('running')
    expect(requests(result.context)).toEqual([])
  })

  it('onAnswer hears the unattended decision and can write data', async () => {
    const agent = harness<Data>(
      humanGate<Data, 'approve' | 'reject'>({
        request: (view, data) => ({
          kind: 'deploy',
          question: `Deploy ${String(data.topic)}?`,
          options: [
            { id: 'approve', label: 'Deploy' },
            { id: 'reject', label: 'Hold', unattended: true },
          ],
          defaultOption: 'reject',
        }),
        onAnswer: (answer, data) => ({ ...data, decided: `${answer.choice}:${answer.by}` }),
      }),
    )
    const result = await agent('go', undefined, { topic: 'x' }, undefined, UNATTENDED)
    expect(result.status).toBe('running')
    expect(result.data.decided).toBe('reject:unattended')
  })

  it('after a resume, the re-entered gate replays and onAnswer hears the person', async () => {
    const agent = harness<Data>(
      humanGate<Data, 'approve' | 'reject'>({
        request: () => ({
          kind: 'deploy',
          key: 'release',
          question: 'Deploy?',
          options: [
            { id: 'approve', label: 'Deploy' },
            { id: 'reject', label: 'Hold', unattended: true },
          ],
          defaultOption: 'reject',
        }),
        onAnswer: (answer, data) => ({ ...data, decided: `${answer.choice}:${answer.by}` }),
      }),
      marker([], 'after'),
    )
    const paused = await agent('go', undefined, undefined, undefined, ATTENDED)
    if (paused.status !== 'paused') throw new Error('expected paused')

    const next = await agent.resume(paused.serialized, {
      [paused.pending[0].requestId]: 'approve',
    })
    expect(next.status).toBe('running')
    expect(next.data.decided).toBe('approve:person')
  })
})
