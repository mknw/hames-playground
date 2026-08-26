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
 * The second scenario used to be the mirror image of that — `screen`, `router`
 * and `describe` pinned to Anthropic in both positions. The 2026-08-26 owner
 * decision moved `router` and `describe` onto the box, so it now pins the
 * OPPOSITE for those two, and the reason it is still worth a scenario is
 * unchanged: a map cannot prove that a real turn honours it. It is also the
 * only thing that would catch a MISSING spread at one of the six describe call
 * sites — `clients-verda.test.ts` scans for the literal once per role, so five
 * of the six could lose it and stay green.
 *
 * `screen` moved too, later the same day, on the owner's rule that no call made
 * under the private tier may be sent to any public AI provider (SA-M5 / SD-4).
 * It is still NOT asserted here, and for the unchanged reason: no agent in this
 * repo enables the opt-in LLM screen, so no turn this suite can run makes a
 * `ScreenUntrustedContent` call and an assertion over zero of them would be
 * theatre. What changed is which pin covers it. `clients-verda.test.ts` used to
 * fail if `clientOverrideFor('screen')` appeared anywhere in `src/lib`; it now
 * fails unless the map entry AND the spread on the screen's own call expression
 * are both present, extracted by balanced parens rather than grepped. The
 * BEHAVIOUR of the screen on that client is measured by the eval suite's
 * `screen-on-the-tier` scenario, which needs a live endpoint and so cannot live
 * here either.
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

  it.runIf(IS_HERMETIC)('moves the cheap side-roles too, not just the heavy ones', async () => {
    const sessionId = newSessionId('side-roles')

    await app.setTier('verda')
    await app.runTurn(sessionId, 'How many nodes are in the graph?')

    // `Router` runs before the loop and the title is awaited inside the turn,
    // so both have landed by now. The describe-of-tool-results does NOT: the
    // turn runner starts it detached, after the answer has reached the caller
    // (`compactAndSave`), so it is polled for rather than assumed. It is also
    // the single most important one to check — a tool result is the payload
    // this whole widening was about (SD-10).
    const describe = await waitForCall(['ResultDescribe', 'ResultDescribeBatch'])

    for (const fn of ['Router', 'GenerateConversationTitle', describe]) {
      const calls = app.fakeLlm.calls.filter((c) => c.fn === fn)
      expect(calls.length, `no ${fn} call was made, so this asserts nothing`).toBeGreaterThan(0)
      for (const call of calls) {
        expect(call.model, `${fn} did not follow the tier switch`).toBe(VERDA_MODEL)
      }
    }
  })

  it.runIf(IS_HERMETIC)('leaves those same roles on Anthropic in the other position', async () => {
    // The counterpart, and the reason the test above is not just "everything is
    // VerdaQwen": these roles have to be steerable in BOTH directions. A call
    // site that hardcoded the override rather than spreading
    // `clientOverrideFor` would pass the verda leg and fail here.
    const sessionId = newSessionId('side-roles-anthropic')

    await app.setTier('anthropic')
    await app.runTurn(sessionId, 'How many nodes are in the graph?')
    const describe = await waitForCall(['ResultDescribe', 'ResultDescribeBatch'])

    for (const fn of ['Router', 'GenerateConversationTitle', describe]) {
      const calls = app.fakeLlm.calls.filter((c) => c.fn === fn)
      // Same vacuity guard as the verda leg above, which this test was missing:
      // `waitForCall` only covers the describe leg (it throws), so `Router` and
      // the title could both go silently uncalled and this loop would iterate
      // nothing and pass.
      expect(calls.length, `no ${fn} call was made, so this asserts nothing`).toBeGreaterThan(0)
      for (const call of calls) {
        expect(call.model, `${fn} did not follow the tier switch`).toBe(FAKE_ANTHROPIC_TIER_MODEL)
      }
    }
  })
})

/**
 * Wait for any of `names` to appear in the fake's log, and return which one.
 *
 * Only the post-turn summarization needs this: `runTurnAndPersist` deliberately
 * does not await it, so a scenario that read the log the instant the turn
 * resolved would assert on a call that had not been made yet — intermittently,
 * which is worse than never.
 */
async function waitForCall(names: readonly string[], timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const hit = app.fakeLlm.calls.find((c) => c.fn !== null && names.includes(c.fn))
    if (hit?.fn) return hit.fn
    if (Date.now() > deadline) {
      throw new Error(
        `e2e: no ${names.join(' / ')} call within ${timeoutMs}ms. The detached ` +
          'summarization either never ran or no longer reaches the describe role.',
      )
    }
    await new Promise((r) => setTimeout(r, 100))
  }
}
