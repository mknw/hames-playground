/**
 * Scenario 4 — the self-hosted endpoint is asleep, and the turn has to wait.
 *
 * The Verda deployment scales to zero. The first call after an idle period pays
 * a container start plus a 27B weight load, measured in MINUTES, and
 * `verda-client.baml` sizes `request_timeout_ms` at ten of them for exactly
 * that reason. But the BAML client's timeout is only the innermost budget. A
 * turn also passes through the harness, the server action or the SSE route, and
 * whatever the caller wraps around it — and any of those can kill a run that
 * the client itself was perfectly happy to keep waiting for.
 *
 * So this scenario withholds the FIRST self-hosted response for
 * `E2E_COLD_START_MS` (default 90s; set 180000 for the full pre-release shape)
 * and asserts the turn still lands. The delay is filtered to the Verda model,
 * so the roles that stay on the Anthropic chain answer immediately — otherwise
 * "the app survived a cold start" would be indistinguishable from "everything
 * was slow", and the failing layer would be unattributable.
 *
 * WHEN IT GOES RED. The assertion messages name the elapsed time and the layer
 * that gave up, because that is the deliverable: a red result here is a finding
 * about a timeout somewhere in the app stack, not a flake. `lib/app.ts` wraps
 * every call in its own generously-sized timeout labelled with the entry point,
 * so a harness-side kill is distinguishable from an app-side one in the message
 * alone.
 *
 * NOT RUN FOR THE ANTHROPIC TIER, deliberately. A metered always-on API has no
 * cold start; a cold-start budget is not a property those chains need, and
 * asserting one on them would manufacture a permanent red for a condition that
 * cannot occur.
 *
 * This file is slow BY CONSTRUCTION. It is the reason the suite is opt-in.
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest'
import { bootApp, newSessionId, eventsOfType, type AppHandles } from '../lib/app'
import { COLD_START_MS, IS_HERMETIC, VERDA_MODEL } from '../lib/mode'

let app: AppHandles

beforeAll(async () => {
  app = await bootApp()
  await app.wipe()
})
afterAll(async () => {
  app.fakeLlm.reset()
  await app.wipe()
})
beforeEach(async () => {
  app.fakeLlm.reset()
  app.fakeGateway.reset()
  await app.setTier('verda')
})

/** Arm the cold start, or leave a live endpoint to be genuinely cold. */
function goCold(app: AppHandles): void {
  if (!IS_HERMETIC) return
  app.fakeLlm.arm({ kind: 'cold-start', ms: COLD_START_MS, model: VERDA_MODEL, times: 1 })
}

describe(`a ${Math.round(COLD_START_MS / 1000)}s cold start on the self-hosted endpoint`, () => {
  it('does not kill the turn taken through the server action', async () => {
    const sessionId = newSessionId('cold-action')
    goCold(app)

    const started = Date.now()
    let failure: unknown = null
    let response: string | undefined
    try {
      response = (await app.runTurn(sessionId, 'How many nodes are in the graph?')).response
    } catch (err) {
      failure = err
    }
    const elapsed = Date.now() - started

    if (failure) {
      throw new Error(
        `the turn died ${elapsed}ms into a ${COLD_START_MS}ms cold start. The layer that gave ` +
          `up is named in the cause below — an "e2e: runTurn(...) exceeded" message is this ` +
          `suite's own bound (raise E2E_TURN_TIMEOUT_MS), anything else is the app stack. ` +
          `Cause: ${failure instanceof Error ? failure.message : String(failure)}`,
      )
    }

    expect(response, 'the cold turn returned no response').toBeTruthy()
    if (IS_HERMETIC) {
      // Prove the wait actually happened rather than the fault silently
      // failing to arm — a fast green here would be the worst outcome.
      expect(
        elapsed,
        `the turn finished in ${elapsed}ms, faster than the ${COLD_START_MS}ms cold start it ` +
          'was supposed to sit through — the fault did not arm',
      ).toBeGreaterThanOrEqual(COLD_START_MS)
      const cold = app.fakeLlm.calls.filter((c) => c.delayedMs > 0)
      expect(cold.length, 'no call was actually delayed').toBe(1)
      expect(cold[0].model).toBe(VERDA_MODEL)
    }

    const row = await app.readRow(sessionId)
    expect(row!.status).toBe('done')
    expect(eventsOfType(row!.serializedContext, 'assistant_message').length).toBeGreaterThan(0)
  })

  it('does not kill the turn taken through the SSE route', async () => {
    // The streaming path holds a `ReadableStream` open across the whole turn,
    // which is one more place a cold start can be cut short than the server
    // action has.
    const sessionId = newSessionId('cold-sse')
    goCold(app)

    const started = Date.now()
    const { status, frames } = await app.runTurnOverSse({
      sessionId,
      message: 'How many nodes are in the graph?',
      agentId: 'search',
    })
    const elapsed = Date.now() - started

    expect(status).toBe(200)
    const done = frames.find((f) => f.event === 'done')
    const error = frames.find((f) => f.event === 'error')
    expect(
      done,
      `no done frame after ${elapsed}ms; frames were [${frames.map((f) => f.event).join(', ')}]` +
        (error ? ` — error frame said: ${JSON.stringify(error.data)}` : ''),
    ).toBeDefined()
    expect(done!.data.status).not.toBe('error')
    expect(done!.data.response).toBeTruthy()
    if (IS_HERMETIC) expect(elapsed).toBeGreaterThanOrEqual(COLD_START_MS)
  })
})
