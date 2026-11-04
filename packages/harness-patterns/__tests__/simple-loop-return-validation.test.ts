import { describe, expect, it, vi } from 'vitest'
import { createContext, createScope } from '../context.server'
import { ownResumable } from '../pattern-capabilities'
import { createEventView } from '../patterns/event-view.server'
import { simpleLoop } from '../patterns/simpleLoop.server'
import { withRunFrame } from '../run-frame.server'
import type { ControllerFn, ControllerInput } from '../types'

describe('simpleLoop.validateReturn replay', () => {
  // Review term 4 mutation: delete roundEffect's return_rejected → none guard.
  // Two replayed return refusals then consume the unusable-answer allowance,
  // so the off-list tool ends the resumed loop instead of recovering.
  it('replaying rejected Returns preserves the uninterrupted recovery allowance', async () => {
    const controller = vi.fn<ControllerFn>(async ({ turn }) => ({
      action: {
        reasoning: 'Scripted round',
        tool_name: turn === 2 ? 'not_available' : 'Return',
        tool_args: turn < 2 ? 'candidate' : 'accepted',
        is_final: turn !== 2,
      },
    }))
    const validateReturn = vi.fn((action: { tool_args: string }) =>
      action.tool_args === 'candidate' ? 'Candidate refused' : undefined,
    )
    const loop = simpleLoop(controller, [], {
      patternId: 'return-check',
      maxTurns: 4,
      maxConsecutiveRecoveries: 1,
      validateReturn,
    })
    const ctx = createContext('Check the candidate')
    const view = createEventView(ctx)
    const uninterrupted = await withRunFrame({}, () =>
      loop.fn(createScope('return-check', {}), view),
    )
    expect(uninterrupted.data.returnText).toBe('accepted')
    expect(controller.mock.calls.map(([input]) => input.turn)).toEqual([0, 1, 2, 3])
    const controlInput: ControllerInput = structuredClone(controller.mock.calls[3][0])

    // A checkpoint immediately after the two refused Returns: use the real
    // recorded rounds, handed through the same resume slot as runChain.
    const checkpoint = uninterrupted.events.filter(
      (event) =>
        (event.type === 'controller_action' || event.type === 'loop_recovery') &&
        (event.data as { turn: number }).turn < 2,
    )
    expect(checkpoint).toHaveLength(4)
    controller.mockClear()
    validateReturn.mockClear()
    const resumed = await withRunFrame(
      {
        resume: {
          continuation: [{ pattern: 'simpleLoop', fingerprint: ownResumable(loop)!.fingerprint }],
          events: checkpoint,
        },
      },
      () => loop.fn(createScope('return-check', {}), view),
    )

    expect(controller.mock.calls.map(([input]) => input.turn)).toEqual([2, 3])
    expect(controller.mock.calls[1][0]).toEqual(controlInput)
    expect(resumed.data.returnText).toBe('accepted')
    expect(validateReturn).toHaveBeenCalledTimes(1)
    expect(resumed.events.filter((event) => event.type === 'error')).toEqual([])
  })
})
