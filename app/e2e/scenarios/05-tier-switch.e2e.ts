/**
 * Scenario 5 — flipping the header switch mid-conversation.
 *
 * The control in the header writes `user_prefs.inference_tier`; every turn
 * reads it once, in `runTurnAndPersist`, and opens an AsyncLocalStorage scope
 * for the whole run. Nothing about that is per-conversation, so a user who
 * flips it between messages expects the NEXT message to move and the thread to
 * be otherwise untouched.
 *
 * Two things have to hold at once, and only one of them is obvious:
 *
 *  1. The switched roles follow the switch. Asserted on the `model` the fake
 *     recorded, per turn — never on the preference, which is the input.
 *  2. The conversation does not fork. The stored blob has to keep accumulating
 *     across the switch: the tier is a routing decision, and a routing decision
 *     that silently started a new context would look identical in the UI until
 *     the user scrolled up.
 *
 * And one that must NOT move: `screen`, `router` and `describe` stay on the
 * Anthropic chain in both positions. `clients-verda.test.ts` pins the map that
 * says so; this pins that a real turn honours it, which is the half a map
 * cannot prove (`SA-M5` / `SD-4` — a summarisation re-point must never drag
 * prompt-injection screening with it).
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest'
import { bootApp, newSessionId, eventsOfType, type AppHandles } from '../lib/app'
import { IS_HERMETIC, FAKE_ANTHROPIC_TIER_MODEL, VERDA_MODEL } from '../lib/mode'

let app: AppHandles

beforeAll(async () => {
  app = await bootApp()
  await app.wipe()
})
afterAll(async () => {
  await app.wipe()
})
beforeEach(() => {
  app.fakeLlm.reset()
  app.fakeGateway.reset()
})

/** Controller calls recorded since `from`, which is how a turn is isolated in
 *  a shared recording. */
function controllersSince(app: AppHandles, from: number): string[] {
  return app.fakeLlm.calls
    .slice(from)
    .filter((c) => c.fn === 'LoopController')
    .map((c) => c.model)
}

describe('switching tier between turns', () => {
  // Hermetic only: reads the model id the fake recorded.
  it.runIf(IS_HERMETIC)('routes each turn per the switch and keeps one conversation', async () => {
    const sessionId = newSessionId('tier-switch')

    await app.setTier('anthropic')
    const mark1 = app.fakeLlm.calls.length
    await app.runTurn(sessionId, 'How many nodes are in the graph?')
    const turn1 = controllersSince(app, mark1)

    await app.setTier('verda')
    const mark2 = app.fakeLlm.calls.length
    await app.runTurn(sessionId, 'And how many relationships?')
    const turn2 = controllersSince(app, mark2)

    await app.setTier('anthropic')
    const mark3 = app.fakeLlm.calls.length
    await app.runTurn(sessionId, 'Summarise both answers.')
    const turn3 = controllersSince(app, mark3)

    expect(turn1.length, 'turn 1 made no controller call').toBeGreaterThan(0)
    expect(turn2.length, 'turn 2 made no controller call').toBeGreaterThan(0)
    expect(turn3.length, 'turn 3 made no controller call').toBeGreaterThan(0)

    expect(new Set(turn1)).toEqual(new Set([FAKE_ANTHROPIC_TIER_MODEL]))
    expect(new Set(turn2)).toEqual(new Set([VERDA_MODEL]))
    expect(new Set(turn3)).toEqual(new Set([FAKE_ANTHROPIC_TIER_MODEL]))

    // One conversation, three turns — the switch did not fork it.
    const row = await app.readRow(sessionId)
    expect(row!.status).toBe('done')
    expect(eventsOfType(row!.serializedContext, 'user_message')).toHaveLength(3)
  })

  it.runIf(IS_HERMETIC)('never moves the roles the switch is not allowed to move', async () => {
    const sessionId = newSessionId('pinned-roles')

    await app.setTier('verda')
    await app.runTurn(sessionId, 'How many nodes are in the graph?')

    // The whole turn ran on the self-hosted tier, so if any of these had moved
    // with it, they would report VERDA_MODEL here.
    const pinned = app.fakeLlm.calls.filter((c) =>
      (
        [
          'Router',
          'ResultDescribe',
          'ResultDescribeBatch',
          'ScreenUntrustedContent',
          'ReferenceSelector',
          'GenerateConversationTitle',
        ] as const
      ).includes(c.fn as never),
    )
    expect(pinned.length, 'no pinned-role call was made, so this asserts nothing').toBeGreaterThan(
      0,
    )
    for (const call of pinned) {
      expect(call.model, `${call.fn} was re-pointed by the tier switch`).toBe(
        FAKE_ANTHROPIC_TIER_MODEL,
      )
    }
  })
})
