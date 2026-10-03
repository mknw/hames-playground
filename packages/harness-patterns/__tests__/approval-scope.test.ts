/**
 * AN APPROVAL ANSWERS ONE PAUSE, NOT EVERY LATER TURN (#456, finding c′).
 *
 * `resumeHarness(serialized, patterns, approved)` writes `approved` onto
 * `ctx.data` so a gate in the resumed run can read the answer. `ctx.data`
 * survives the turn boundary (`serializeContext` is a plain `JSON.stringify`),
 * so unless `continueSession` clears the flag, one "yes" rides every later turn
 * and a gate reached again proceeds without asking: fail-open, and silent.
 *
 * Driven end to end through the public entry points and the REAL `runChain`,
 * with the gate built the only way a package consumer can build one today.
 * Core has no in-chain pause (#433 §0: a pattern holds a `PatternScope`, and
 * `setPaused` needs the `UnifiedContext`), so the gate pattern records a
 * `pendingAction` and the HOST parks the context with the public `setPaused`.
 * That is the shape the #433 design replaces; the property pinned here is the
 * one it keeps ("answers last for the run", decision 11).
 *
 * MUTATION: delete `delete … .approved` from `continueSession`'s per-turn reset
 * → both tests go red at the third turn: the approved write runs again without
 * a pause (`performed` 2, not 1), and the rejected one is refused again without
 * asking (`refused` 2, not 1).
 *
 * MUTATION: clear `approved` in `resumeHarness` just before its `runChain` (the
 * over-fix) → both tests go red at the resume step: the answer never reaches
 * the gate it was given for (`performed` / `refused` 0, not 1).
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../assert.server', () => ({ assertServerOnImport: vi.fn() }))

import {
  harness,
  continueSession,
  resumeHarness,
  type HarnessData,
  type HarnessResultScoped,
} from '../harness.server'
import { serializeContext, setPaused } from '../context.server'
import { configurePattern } from '../patterns/chain.server'
import type { ConfiguredPattern, WithApproval } from '../types'

type GateData = HarnessData & WithApproval & Record<string, unknown>

/** A gated write: runs only on an approval, and asks for one otherwise. */
function gatedWrite(log: { performed: number; refused: number }): ConfiguredPattern<GateData> {
  return configurePattern<GateData>('gated-write', async (scope) => {
    const { approved } = scope.data
    if (approved === true) {
      log.performed++
      scope.data = { ...scope.data, pendingAction: undefined, response: 'written' }
    } else if (approved === false) {
      log.refused++
      scope.data = { ...scope.data, pendingAction: undefined, response: 'not written' }
    } else {
      scope.data = {
        ...scope.data,
        pendingAction: { action: 'write', payload: null, reason: 'writes the graph' },
        response: undefined,
      }
    }
    return scope
  })
}

/** The host half of today's gate: a turn that left a pending action is parked. */
function park(result: HarnessResultScoped<GateData>): { serialized: string; paused: boolean } {
  if (!result.data.pendingAction) return { serialized: result.serialized, paused: false }
  setPaused(result.context)
  return { serialized: serializeContext(result.context), paused: true }
}

describe('an approval answers one pause', () => {
  it('a later turn that reaches the gate pauses again instead of running', async () => {
    const log = { performed: 0, refused: 0 }
    const patterns = [gatedWrite(log)]

    // Turn 1 reaches the gate and is parked.
    const first = park(await harness<GateData>(...patterns)('write X', 'sess-approval'))
    expect(first.paused).toBe(true)
    expect(log.performed).toBe(0)

    // The person approves THAT pause, and the write runs once.
    const resumed = await resumeHarness<GateData>(first.serialized, patterns, true)
    const second = park(resumed)
    expect(log.performed).toBe(1)
    expect(second.paused).toBe(false)

    // Turn 3 asks for another write. Nobody has approved it.
    const continued = await continueSession<GateData>(second.serialized, patterns, 'write Y')
    const third = park(continued)
    expect(log.performed).toBe(1)
    expect(third.paused).toBe(true)
    expect(continued.data.approved).toBeUndefined()

    // Approving the new pause is what runs it.
    await resumeHarness<GateData>(third.serialized, patterns, true)
    expect(log.performed).toBe(2)
  })

  it('a rejection does not carry either: the later turn asks rather than refusing', async () => {
    const log = { performed: 0, refused: 0 }
    const patterns = [gatedWrite(log)]

    const first = park(await harness<GateData>(...patterns)('write X', 'sess-rejection'))
    const second = park(await resumeHarness<GateData>(first.serialized, patterns, false))
    expect(log.refused).toBe(1)

    const third = park(await continueSession<GateData>(second.serialized, patterns, 'write Y'))
    expect(log.refused).toBe(1)
    expect(log.performed).toBe(0)
    expect(third.paused).toBe(true)
  })
})
