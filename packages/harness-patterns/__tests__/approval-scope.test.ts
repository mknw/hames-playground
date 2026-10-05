/**
 * AN ANSWER LASTS FOR ITS RUN, NOT EVERY LATER TURN (#456, finding c′),
 * rewritten around events for #433 S3 (pin H25).
 *
 * #457 closed this for the boolean `resumeHarness(serialized, patterns,
 * approved)`: `approved` rode `ctx.data`, so unless `continueSession` cleared
 * it, one "yes" rode every later turn and a gate reached again proceeded
 * without asking. That API is gone. A decision is now a `hitl_response` event
 * bound to the `hitl_request` it answers, and a gate reads it back through
 * `askHuman`, which replays only from the CURRENT run's journal — so the
 * property holds by construction rather than by a reset a host can skip.
 *
 * Driven end to end through the public entry points and the REAL `runChain`,
 * with the gate built the way a package consumer builds one now: `askHuman`
 * in a pattern body.
 *
 * MUTATION: `readHitl`'s run window starts at the FIRST user_message (#472's
 * M7) → the first two tests go red at their third turn, where the gate replays
 * the earlier run's answer instead of asking (`performed` 2, not 1, and
 * `refused` 2, not 1); the third goes red at its second message
 * (`performed` 2, not 1).
 *
 * MUTATION: `askHuman` skips the journal lookup → the first two tests go red at
 * the resume step: the answer never reaches the gate it was given for, which
 * asks again instead (`performed` 0, not 1).
 */

import { describe, expect, it } from 'vitest'
import {
  continueSession,
  harness,
  resumeHarness,
  type HarnessResultScoped,
} from '../harness.server'
import { askHuman, readHitl } from '../hitl.server'
import { configurePattern } from '../patterns/chain.server'
import type { ConfiguredPattern, HitlOption } from '../types'

type Data = { response?: string; [key: string]: unknown }

const OPTIONS: HitlOption[] = [
  { id: 'approve', label: 'Approve' },
  { id: 'reject', label: 'Reject', unattended: true },
]

/** A gated write: asks, runs only on an approval, and records a refusal. */
function gatedWrite(
  log: { performed: number; refused: number },
  name = 'gated-write',
  key = 'write',
): ConfiguredPattern<Data> {
  return configurePattern<Data>(name, async (scope) => {
    const outcome = await askHuman({
      kind: 'confirm',
      key,
      question: 'Write to the graph?',
      options: OPTIONS,
      defaultOption: 'reject',
    })
    if (outcome.status === 'pending') return scope
    if (outcome.choice === 'approve') log.performed++
    else log.refused++
    scope.data = { ...scope.data, response: outcome.choice === 'approve' ? 'written' : 'refused' }
    return scope
  })
}

/** The one request a paused result waits on. */
function waitingOn(result: HarnessResultScoped<Data>): string {
  expect(result.status).toBe('paused')
  const { pending } = readHitl(result.context)
  expect(pending).toHaveLength(1)
  return pending[0].requestId
}

describe('an answer lasts for its run, not every later turn', () => {
  it('a later turn that reaches the gate pauses again instead of running', async () => {
    const log = { performed: 0, refused: 0 }
    const patterns = [gatedWrite(log)]

    // Turn 1 reaches the gate and pauses.
    const first = await harness<Data>(...patterns)('write X', 'sess-approval')
    const asked = waitingOn(first)
    expect(log.performed).toBe(0)

    // The person approves THAT pause, and the write runs once.
    const resumed = await resumeHarness<Data>(first.serialized, patterns, { [asked]: 'approve' })
    expect(log.performed).toBe(1)
    expect(resumed.status).toBe('running')

    // Turn 3 asks for another write. Nobody has approved it.
    const third = await continueSession<Data>(resumed.serialized, patterns, 'write Y')
    const askedAgain = waitingOn(third)
    expect(askedAgain).not.toBe(asked)
    expect(log.performed).toBe(1)

    // Approving the new pause is what runs it.
    await resumeHarness<Data>(third.serialized, patterns, { [askedAgain]: 'approve' })
    expect(log.performed).toBe(2)
  })

  it('a rejection does not carry either: the later turn asks rather than refusing', async () => {
    const log = { performed: 0, refused: 0 }
    const patterns = [gatedWrite(log)]

    const first = await harness<Data>(...patterns)('write X', 'sess-rejection')
    const second = await resumeHarness<Data>(first.serialized, patterns, {
      [waitingOn(first)]: 'reject',
    })
    expect(log.refused).toBe(1)

    const third = await continueSession<Data>(second.serialized, patterns, 'write Y')
    waitingOn(third)
    expect(log.refused).toBe(1)
    expect(log.performed).toBe(0)
  })

  it('a run paused at a second gate does not hand the first answer to a new message', async () => {
    // Paused AND holding an answer: what a resumed run leaves when it pauses
    // again at a later gate. The new message supersedes the second gate, and
    // its run starts with an empty journal.
    const log = { performed: 0, refused: 0 }
    const patterns = [gatedWrite(log, 'write-a', 'a'), gatedWrite(log, 'write-b', 'b')]

    const first = await harness<Data>(...patterns)('write A then B', 'sess-repaused')
    const second = await resumeHarness<Data>(first.serialized, patterns, {
      [waitingOn(first)]: 'approve',
    })
    waitingOn(second)
    expect(log.performed).toBe(1)

    const next = await continueSession<Data>(second.serialized, patterns, 'write A again')
    waitingOn(next)
    expect(log.performed).toBe(1)
    expect(readHitl(next.context).answers.size).toBe(0)
  })
})
