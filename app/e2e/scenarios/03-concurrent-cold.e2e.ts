/**
 * Scenario 3 — two conversations at once, against a cold endpoint.
 *
 * The preview is multi-user, the self-hosted deployment is ONE replica that
 * scales to zero, and the pattern cache, the tier scope and the in-flight
 * gauge are all process-wide. So the question this scenario asks is not "is it
 * fast" — it is "does one conversation's slow first call corrupt another's".
 *
 * Three specific ways that could go wrong, all pinned below:
 *
 *  - `runWithInferenceTier` is an AsyncLocalStorage scope. If it leaked across
 *    concurrent turns, conversation B would run on A's tier.
 *  - `getOrBuildPatterns` has no in-flight dedupe (see `session.server.ts`'s
 *    ref-counted `building` map), so two overlapping builds are a real shape.
 *  - The fake's replies are computed per request, not from stored state, which
 *    is what makes an interleaving failure attributable to the app rather than
 *    to the test double.
 *
 * "Cold" is modelled by withholding the FIRST N responses. The delay is short
 * on purpose — scenario 4 owns the minutes-long case; this one owns the
 * interleaving, and the two do not need to be slow twice.
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest'
import { bootApp, newSessionId, eventsOfType, type AppHandles } from '../lib/app'
import { IS_HERMETIC, FAKE_ANTHROPIC_TIER_MODEL, VERDA_MODEL } from '../lib/mode'

/** Long enough that the two turns genuinely overlap, short enough that the
 *  file stays under a few seconds. */
const COLD_MS = Number.parseInt(process.env.E2E_CONCURRENT_COLD_MS ?? '3000', 10)

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

describe('two conversations in flight together', () => {
  it('both complete on a cold endpoint, and neither disrupts the other', async () => {
    await app.setTier('verda')
    if (IS_HERMETIC) app.fakeLlm.arm({ kind: 'cold-start', ms: COLD_MS, times: 2 })

    const a = newSessionId('concurrent-a')
    const bee = newSessionId('concurrent-b')

    const started = Date.now()
    const [ra, rb] = await Promise.all([
      app.runTurn(a, 'How many nodes are in the graph?'),
      app.runTurn(bee, 'List the relationship types.'),
    ])
    const elapsed = Date.now() - started

    expect(ra.response).toBeTruthy()
    expect(rb.response).toBeTruthy()

    for (const id of [a, bee]) {
      const row = await app.readRow(id)
      expect(row, `${id} did not persist`).not.toBeNull()
      expect(row!.status).toBe('done')
      // Exactly one user message each — a conversation that picked up the
      // other's message would show two, which is the concrete shape of a
      // leaked request scope.
      const users = eventsOfType(row!.serializedContext, 'user_message').map(
        (d) => (d as { content?: string }).content ?? '',
      )
      expect(users).toHaveLength(1)
    }

    const rowA = await app.readRow(a)
    const rowB = await app.readRow(bee)
    expect(eventsOfType(rowA!.serializedContext, 'user_message')[0]).toMatchObject({
      content: 'How many nodes are in the graph?',
    })
    expect(eventsOfType(rowB!.serializedContext, 'user_message')[0]).toMatchObject({
      content: 'List the relationship types.',
    })

    if (IS_HERMETIC) {
      // They really did overlap: two sequential cold starts would cost at
      // least twice the delay. This is the assertion that keeps the scenario
      // from silently degrading into "two turns, one after the other".
      expect(elapsed, 'the two turns did not overlap').toBeLessThan(COLD_MS * 2)
    }
  })

  // Hermetic only: reads the model id the fake recorded.
  it.runIf(IS_HERMETIC)(
    'keeps each conversation on its own tier when the two run together',
    async () => {
      // Both conversations belong to the same (bypass) user, so the stored
      // preference cannot differ between them — the per-run scope is what has to
      // hold, and the only way to open two different ones concurrently is to
      // start each turn under a different preference. Setting it between the two
      // `runTurn` calls is exactly how the header switch behaves when a user
      // flips it while a turn is already running.
      await app.setTier('anthropic')
      app.fakeLlm.arm({ kind: 'cold-start', ms: COLD_MS, times: 1 })
      const slow = app.runTurn(newSessionId('tier-slow'), 'How many nodes are in the graph?')

      // Give the first turn time to enter its scope and block on the cold call.
      await new Promise((r) => setTimeout(r, 250))
      await app.setTier('verda')
      const fast = app.runTurn(newSessionId('tier-fast'), 'List the relationship types.')

      await Promise.all([slow, fast])

      const controllers = app.fakeLlm.calls.filter((c) => c.fn === 'LoopController')
      expect(controllers.length).toBeGreaterThanOrEqual(2)
      // The run that started under `anthropic` must have kept it for its whole
      // turn even though the preference changed underneath it, and the run that
      // started under `verda` must have taken the self-hosted route. If the
      // scope leaked, every controller call would carry the same model.
      const models = new Set(controllers.map((c) => c.model))
      expect(
        models,
        `expected both tiers among the controller calls, saw ${[...models].join(', ')}`,
      ).toEqual(new Set([FAKE_ANTHROPIC_TIER_MODEL, VERDA_MODEL]))
    },
  )
})
