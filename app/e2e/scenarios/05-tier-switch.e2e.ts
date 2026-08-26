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
 *     recorded, per turn — never on the preference, which is the input. Both of
 *     the roles this agent's chain actually uses are checked (`controller` and
 *     `compactExecution`, i.e. `LoopController` and `Synthesize`): each is a
 *     separate call site spreading its own `clientOverrideFor(role)`, so one
 *     being right says nothing about the other.
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
import { IS_HERMETIC, FAKE_ANTHROPIC_TIER_MODEL, VERDA_MODEL, type Tier } from '../lib/mode'

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

/**
 * The models one function's calls were routed to inside `[from, to)`.
 *
 * BOUNDED at both ends, which matters: the fake records every call in one
 * array, so an open-ended `slice(from)` read after all three turns have run
 * would pick up the later turns' calls too and see both tiers in every window.
 */
function modelsBetween(app: AppHandles, from: number, to: number, fn: string): string[] {
  return app.fakeLlm.calls
    .slice(from, to)
    .filter((c) => c.fn === fn)
    .map((c) => c.model)
}

describe('switching tier between turns', () => {
  // Hermetic only: reads the model id the fake recorded.
  it.runIf(IS_HERMETIC)('routes each turn per the switch and keeps one conversation', async () => {
    const sessionId = newSessionId('tier-switch')

    // Each turn's window is closed before the next one opens, so a call can
    // only ever be attributed to the turn that made it.
    const turns: Array<{ tier: Tier; from: number; to: number }> = []
    for (const [tier, message] of [
      ['anthropic', 'How many nodes are in the graph?'],
      ['verda', 'And how many relationships?'],
      ['anthropic', 'Summarise both answers.'],
    ] as const) {
      await app.setTier(tier)
      const from = app.fakeLlm.calls.length
      await app.runTurn(sessionId, message)
      turns.push({ tier, from, to: app.fakeLlm.calls.length })
    }

    // Both of the search agent's switched roles, not just the loud one.
    // `controller` is `LoopController`; `compactExecution` is `Synthesize`, and
    // it is in `VERDA_CLIENT_BY_ROLE` too — a call site that forgot to spread
    // `clientOverrideFor('compactExecution')` would leave the answer-writing
    // call on Anthropic through a turn the user asked to keep self-hosted, and
    // the controller assertion alone would stay green.
    for (const fn of ['LoopController', 'Synthesize'] as const) {
      turns.forEach(({ tier, from, to }, i) => {
        const models = modelsBetween(app, from, to, fn)
        const expected = tier === 'verda' ? VERDA_MODEL : FAKE_ANTHROPIC_TIER_MODEL
        expect(models.length, `turn ${i + 1} made no ${fn} call`).toBeGreaterThan(0)
        expect(new Set(models), `${fn} on turn ${i + 1} (${tier})`).toEqual(new Set([expected]))
      })
    }

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
