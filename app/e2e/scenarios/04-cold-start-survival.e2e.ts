/**
 * Scenario 4 — a self-hosted call is slow, and the turn has to wait it out.
 *
 * WHAT IT NOW TARGETS, because this changed under it. The scenario was written
 * when the first call of a session absorbed the deployment's cold start behind a
 * ten-minute `request_timeout_ms`. Wake-then-run moved that wait out in front,
 * into a poll with its own 600s budget (30s per attempt, hermetically raised
 * above this scenario's delay — see `lib/mode.ts`), and the BAML client's budget
 * became a WARM-call one (180s, derived from its own output cap — see
 * `baml_src/verda-client.baml`). Two separate budgets, and this scenario used to
 * cover neither cleanly: armed `times: 1`, its delay landed on the wake ping,
 * which meant it exercised `VERDA_WAKE_TIMEOUT_MS` and passed — while nothing at
 * any layer exercised the 180s the client's own calls live under (#279 review,
 * F4). Passing for the wrong reason is the failure mode this suite exists to
 * avoid, so the delay is now aimed PAST the ping (`wake: false`): the box comes
 * up promptly and a real BAML call is the thing that takes 90s.
 *
 * The BAML client's timeout is only the innermost budget. A turn also passes
 * through the harness, the server action or the SSE route, and whatever the
 * caller wraps around it — and any of those can kill a call the client itself
 * was perfectly happy to keep waiting for. That is what a green result here
 * says: every layer above the client tolerates a slow model call.
 *
 * The delay is filtered to the Verda model, so the roles that stay on the
 * Anthropic chain answer immediately — otherwise "the app survived a slow call"
 * would be indistinguishable from "everything was slow", and the failing layer
 * would be unattributable.
 *
 * THE OTHER DIRECTION — a call that EXCEEDS 180s failing cleanly — is not here,
 * and the reason is wall-clock: it costs three minutes per assertion by
 * construction, since the number under test is the client's own. What covers it
 * instead is an arithmetic pin rather than an execution: `clients-verda.test.ts`
 * asserts the timeout against the client's declared `max_tokens`, which is where
 * the number comes from. Named rather than left as a gap.
 *
 * WHEN IT GOES RED. The assertion messages name the elapsed time and the layer
 * that gave up, because that is the deliverable: a red result here is a finding
 * about a timeout somewhere in the app stack, not a flake. `lib/app.ts` wraps
 * every call in its own generously-sized timeout labelled with the entry point,
 * so a harness-side kill is distinguishable from an app-side one in the message
 * alone.
 *
 * NOT RUN FOR THE ANTHROPIC TIER, deliberately. A metered always-on API has no
 * scale-to-zero box behind it; a multi-minute per-call budget is not a property
 * those chains need, and asserting one on them would manufacture a permanent red
 * for a condition that cannot occur.
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
  // A ping has to be SENT for the `wake: false` filter to have anything to skip
  // past, and one process shares one warm clock — see `goToSleep`.
  await app.goToSleep()
})

/**
 * Arm ONE slow self-hosted BAML call, or leave a live endpoint to be genuinely
 * slow.
 *
 * `wake: false` is the whole aim of the scenario: the wake ping answers at once
 * (so the box is "up" and the harness starts), and the delay lands on the first
 * BAML call behind it — the request the client's own `request_timeout_ms`
 * bounds. Without it the ping eats the fault and this file measures a different
 * timeout than its name claims.
 */
function goSlow(app: AppHandles): void {
  if (!IS_HERMETIC) return
  app.fakeLlm.arm({
    kind: 'cold-start',
    ms: COLD_START_MS,
    model: VERDA_MODEL,
    times: 1,
    wake: false,
  })
}

describe(`a ${Math.round(COLD_START_MS / 1000)}s self-hosted call the app must wait out`, () => {
  it('does not kill the turn taken through the server action', async () => {
    const sessionId = newSessionId('cold-action')
    goSlow(app)

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
        `the turn died ${elapsed}ms into a ${COLD_START_MS}ms slow call. The layer that gave ` +
          `up is named in the cause below — an "e2e: runTurn(...) exceeded" message is this ` +
          `suite's own bound (raise E2E_TURN_TIMEOUT_MS), anything else is the app stack. ` +
          `Cause: ${failure instanceof Error ? failure.message : String(failure)}`,
      )
    }

    expect(response, 'the slow turn returned no response').toBeTruthy()
    if (IS_HERMETIC) {
      // Prove the wait actually happened rather than the fault silently
      // failing to arm — a fast green here would be the worst outcome.
      expect(
        elapsed,
        `the turn finished in ${elapsed}ms, faster than the ${COLD_START_MS}ms delay it ` +
          'was supposed to sit through — the fault did not arm',
      ).toBeGreaterThanOrEqual(COLD_START_MS)
      const slow = app.fakeLlm.calls.filter((c) => c.delayedMs > 0)
      expect(slow.length, 'no call was actually delayed').toBe(1)
      expect(slow[0].model).toBe(VERDA_MODEL)
      // AND IT WAS A BAML CALL, not the wake ping — the assertion that keeps
      // this file measuring `request_timeout_ms` rather than
      // `VERDA_WAKE_TIMEOUT_MS`. `fn` is null for the ping and the function name
      // for everything else, so this is the difference stated structurally.
      expect(
        slow[0].outcome,
        'the delay landed on the wake ping, so this run exercised the wake bound and not the ' +
          "BAML client's — the `wake: false` filter is not applying",
      ).not.toBe('wake')
      expect(slow[0].fn, 'the delayed request was not a BAML call').not.toBeNull()
    }

    const row = await app.readRow(sessionId)
    expect(row!.status).toBe('done')
    expect(eventsOfType(row!.serializedContext, 'assistant_message').length).toBeGreaterThan(0)
  })

  it('does not kill the turn taken through the SSE route', async () => {
    // The streaming path holds a `ReadableStream` open across the whole turn,
    // which is one more place a slow call can be cut short than the server
    // action has.
    const sessionId = newSessionId('cold-sse')
    goSlow(app)

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
