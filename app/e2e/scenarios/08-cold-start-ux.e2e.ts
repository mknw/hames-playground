/**
 * Scenario 8 — the user is told the box is starting, while it is starting, and
 * the box is started before the harness runs.
 *
 * Scenario 4 pins that a cold start does not KILL the turn. This one pins the
 * other half of the same wait, which #273 left open as owner decision D-c:
 * for those minutes the chat produces nothing a human can see. The SSE
 * keep-alive proves the connection is alive to an intermediary and is invisible
 * to a person by construction, so a user watching a still screen for 146
 * seconds has no way to tell a warming GPU from a hung app — and reloads.
 *
 * The fix is a turn-level `warming` frame, and the property that makes it worth
 * anything is a TIMING one: it has to arrive DURING the wait. A notice emitted
 * alongside the answer is not a notice. `readSse` stamps each frame with its
 * arrival time for exactly this claim, which is why the assertions below are
 * about `frame.at` and not only about frame order.
 *
 * WHO PAYS THE WAIT changed with wake-then-run. A private-tier turn now sends
 * throwaway `max_tokens: 1` requests FIRST — a POLL since 2026-08-27, retried
 * until one is answered — and starts the harness only once one is
 * (`inference/wake.server.ts`), which is what let the BAML client's timeout drop
 * from ten minutes to three. So the cold start this scenario injects is absorbed
 * by the WAKE, and the fake records those requests with their own
 * `wake` outcome — which makes the ordering assertable in a way it was not
 * before: the notice, then the wake, then any model call at all. Previously the
 * notice merely preceded the first controller call, and "the harness started
 * against a sleeping box" was indistinguishable from "the harness waited".
 *
 * The client half — the spinner replacing the progress bar, and the bar coming
 * back on the first frame after — is `turn-stream.test.ts` and
 * `LiveProgressBar.test.tsx`, which can drive a state machine and a DOM. What
 * a scenario here can prove is what the server actually put on the wire, and
 * when. Both halves read the same `WarmingEventData`.
 *
 * NOT RUN FOR THE ANTHROPIC TIER as a positive case, for scenario 4's reason —
 * a metered always-on API has no cold start. It IS run as a negative one: the
 * frame must not appear there, or the notice would be telling users about a
 * wait their tier does not have.
 *
 * HERMETIC ONLY, and unlike scenario 4 this is not a preference. Scenario 4 can
 * run live because it is the FIRST file and the deployment is genuinely asleep;
 * by the time this one runs the box has been warm for several files, so there
 * is no cold start to observe and the notice correctly would not fire. Skipped
 * with `describe.runIf` rather than an early return, so live mode reports it as
 * skipped instead of green-while-asserting-nothing.
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest'
import { bootApp, newSessionId, type AppHandles, type SseFrame } from '../lib/app'
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
  // The box goes back to sleep between tests. One process, one warm clock (see
  // `goToSleep`): a successful wake ping in an earlier test stamps it, and every
  // assertion in this file is about the cold path.
  await app.goToSleep()
})

/** Withhold the first self-hosted response for the configured cold start. */
function goCold(app: AppHandles): void {
  app.fakeLlm.arm({ kind: 'cold-start', ms: COLD_START_MS, model: VERDA_MODEL, times: 1 })
}

/** The first frame carrying evidence that the self-hosted model itself
 *  answered — the accounting BAML stamps on the call, naming the client it
 *  actually selected. The router's own frames precede it and are not it. */
function firstVerdaAnswer(frames: SseFrame[]): number {
  return frames.findIndex((f) => {
    const call = (f.data as { llmCall?: { clientName?: string } }).llmCall
    return call?.clientName === 'VerdaQwen'
  })
}

/** Requests the fake served as wake pings, oldest first. */
function wakePings(app: AppHandles): readonly { at: number; delayedMs: number }[] {
  return app.fakeLlm.calls.filter((c) => c.outcome === 'wake')
}

/**
 * Run `body` with the wake poll's tunables overridden, then put them back.
 *
 * The three vars are read per call inside `wake.server.ts` (deliberately — the
 * rest of that route reads env per call too), which is what makes this possible
 * without a re-import. `bootApp` sets a hermetic-wide attempt bound; the two
 * tests that are ABOUT the poll rather than about the notice narrow it here, so
 * one test's timings cannot leak into the others' — the restore is in a
 * `finally` for exactly that reason.
 */
async function withWakeEnv<T>(vars: Record<string, string>, body: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]))
  Object.assign(process.env, vars)
  try {
    return await body()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

describe.runIf(IS_HERMETIC)('the cold-start notice', () => {
  it('reaches the user during the wait, not alongside the answer', async () => {
    await app.setTier('verda')
    const sessionId = newSessionId('coldux-verda')
    goCold(app)

    const started = Date.now()
    const { status, frames } = await app.runTurnOverSse({
      sessionId,
      message: 'How many nodes are in the graph?',
      agentId: 'search',
    })
    expect(status).toBe(200)

    const warming = frames.filter((f) => f.event === 'warming')
    expect(
      warming.length,
      `expected exactly one warming frame; frames were [${frames.map((f) => f.event).join(', ')}]`,
    ).toBe(1)

    // The estimate is a number the UI will state as an expectation, so it has
    // to be a positive duration and it has to say where it came from. This
    // process never installed the usage recorder (see the README's "outside
    // the traversal"), so nothing has measured a cold start here and the
    // honest answer is the published reading.
    const notice = warming[0].data as { estimateMs: number; basis: string; samples: number }
    expect(notice.estimateMs).toBeGreaterThan(0)
    expect(notice.basis).toBe('default')
    expect(notice.samples).toBe(0)

    const done = frames.find((f) => f.event === 'done')
    expect(done, 'the turn did not finish').toBeDefined()

    // The claim, and the only one a "spinner then progress" feature can be held
    // to on the wire: the notice landed inside the wait, and the answer landed
    // after it. A notice emitted with the answer would satisfy the ordering
    // check below and still leave the user watching a still screen.
    const noticeAfter = warming[0].at - started
    const doneAfter = done!.at - started
    expect(
      noticeAfter,
      `the notice arrived ${noticeAfter}ms in, past the ${COLD_START_MS}ms cold start — the ` +
        'user watched the whole wait before being told anything',
    ).toBeLessThan(COLD_START_MS)
    expect(
      doneAfter,
      `the turn finished in ${doneAfter}ms, faster than the ${COLD_START_MS}ms cold start it was ` +
        'supposed to sit through — the fault did not arm',
    ).toBeGreaterThanOrEqual(COLD_START_MS)

    // And the ordering: nothing from the self-hosted model precedes the notice.
    const answerIdx = firstVerdaAnswer(frames)
    const warmingIdx = frames.indexOf(warming[0])
    expect(answerIdx, 'no frame carried a VerdaQwen call').toBeGreaterThan(-1)
    expect(warmingIdx).toBeLessThan(answerIdx)
    // Something follows it, which is what the client clears the spinner on —
    // there is no dedicated clear frame by design.
    expect(frames.length - 1).toBeGreaterThan(warmingIdx)

    // WAKE THEN RUN. Exactly one throwaway request, it is the one that absorbed
    // the injected cold start, and it was the FIRST thing on the wire — which is
    // the whole reason the BAML client's timeout could drop to 180s. A harness
    // that started against the sleeping box would show the delay on a
    // LoopController call instead, and every such call would now be aborted at
    // 180s against this 90s+ fault.
    // ONE attempt, because the hermetic run sets the poll's per-attempt bound
    // above the injected delay (`WAKE_ATTEMPT_TIMEOUT_MS`) — the fake always
    // answers, so one attempt is its faithful shape and this test stays about
    // the notice. `keeps polling until the box answers` below is the one that
    // lowers that bound and asserts the retry.
    const pings = wakePings(app)
    expect(pings, 'the turn did not wake the box before running').toHaveLength(1)
    expect(pings[0].delayedMs).toBe(COLD_START_MS)
    expect(
      app.fakeLlm.calls[0].outcome,
      `the first request was a ${app.fakeLlm.calls[0].fn ?? 'non-BAML'} call, not the wake ping`,
    ).toBe('wake')
    // Nothing else was delayed: the wake paid the whole cold start, so every
    // model call that followed it was a warm call.
    expect(app.fakeLlm.calls.filter((c) => c.delayedMs > 0)).toHaveLength(1)
  })

  /** Assert the turn ended as a VISIBLE failure the user can read. */
  function expectVisibleWakeFailure(frames: SseFrame[]): void {
    const error = frames.find((f) => f.event === 'error')
    expect(
      error,
      `no error frame; frames were [${frames.map((f) => f.event).join(', ')}]`,
    ).toBeDefined()
    // The sentence a person reads. It names the box rather than a status code,
    // and says the prompt went nowhere else.
    const message = (error!.data as { error?: string }).error ?? ''
    expect(message).toContain('the private inference box did not wake')
    expect(message).toContain('nothing was sent to any other provider')
  }

  /** The two BAML functions that would prove the harness ran anyway. Named
   *  FUNCTIONS rather than "no BAML call at all": an earlier test's post-turn
   *  summarization is detached by design (`compactAndSave`), so its
   *  `ResultDescribe` can land in this test's window after `reset()` and has
   *  nothing to do with this turn. `Router` is the first call any turn makes and
   *  `LoopController` is the first one inside the loop. */
  function harnessCalls(app: AppHandles): readonly unknown[] {
    return app.fakeLlm.calls.filter((c) => c.fn === 'Router' || c.fn === 'LoopController')
  }

  it('ends the turn as a visible error when the deployment REFUSES the wake', async () => {
    // THE OTHER HALF of #273's D-b, and the property the owner asked for by name:
    // never a silent hang. A wake that fails must not fall through to the harness
    // (same wait, now against a 180s timeout) and must not fall back to Anthropic
    // (confidential prompts to the provider the tier exists to avoid). It ends the
    // turn, and the user is TOLD.
    //
    // A 400 rather than the 503 this test used before the wake became a poll, and
    // the swap is the behaviour change: a 503 is a box saying "not yet" and is now
    // RETRIED for the whole budget, while vLLM's 400 for a request it will never
    // accept is a property of the request rather than of the box's state. Polling
    // that out would turn a one-line misconfiguration into a ten-minute spinner,
    // so it ends the poll on the first attempt — which is what makes this test
    // finish in milliseconds rather than in ten minutes.
    await app.setTier('verda')
    const sessionId = newSessionId('coldux-wake-refused')
    app.fakeLlm.arm({ kind: 'status', status: 400, message: 'unknown model', model: VERDA_MODEL })

    const { status, frames } = await app.runTurnOverSse({
      sessionId,
      message: 'How many nodes are in the graph?',
      agentId: 'search',
    })

    expect(status).toBe(200)
    expectVisibleWakeFailure(frames)
    expect(harnessCalls(app), 'the harness ran anyway, against a box that never woke').toEqual([])
  })

  it('ends the turn as a visible error when the box never comes up', async () => {
    // The other failure shape, and the one the 2026-08-27 incident actually was:
    // nothing refuses anything, the box simply never answers. The poll keeps
    // trying until its overall budget runs out and THEN fails visibly — the
    // budget is what bounds the spinner, and it must not be the harness or the
    // browser that gives up first.
    //
    // Driven at 1/300th of the shipped budget, because the property under test is
    // "it gives up, loudly, at the budget" and the budget's VALUE is an arithmetic
    // decision pinned in `verda-wake.test.ts`. A 503 is a transient status, so
    // every attempt is retried.
    await app.setTier('verda')
    const sessionId = newSessionId('coldux-wake-never')
    app.fakeLlm.arm({ kind: 'status', status: 503, message: 'no capacity', model: VERDA_MODEL })

    const { status, frames } = await withWakeEnv(
      {
        VERDA_WAKE_TIMEOUT_MS: '2000',
        VERDA_WAKE_ATTEMPT_TIMEOUT_MS: '500',
        VERDA_WAKE_POLL_INTERVAL_MS: '100',
      },
      () =>
        app.runTurnOverSse({
          sessionId,
          message: 'How many nodes are in the graph?',
          agentId: 'search',
        }),
    )

    expect(status).toBe(200)
    expectVisibleWakeFailure(frames)
    expect(harnessCalls(app), 'the harness ran anyway, against a box that never woke').toEqual([])
  })

  it('keeps polling until the box answers, rather than riding one request', async () => {
    // THE 2026-08-27 CHANGE, at the app path. The live platform was observed
    // abandoning every request that arrived while the container was starting —
    // a 1-token probe held open for 590s returned nothing while the box came up
    // at ~360s — so a wake that rides ONE request can miss a box that woke.
    //
    // Modelled here as a first attempt the fake withholds for longer than the
    // attempt bound: the poll abandons it and a later attempt (the one-shot fault
    // now spent) meets a box that answers. The decisive assertion is the LAST
    // one — a wake ping the fake did not delay could only have been a second
    // attempt.
    await app.setTier('verda')
    const sessionId = newSessionId('coldux-wake-polls')
    const attemptMs = 1000
    app.fakeLlm.arm({
      kind: 'cold-start',
      ms: attemptMs * 3,
      model: VERDA_MODEL,
      wake: true,
      times: 1,
    })

    const started = Date.now()
    const { status, frames } = await withWakeEnv(
      {
        VERDA_WAKE_ATTEMPT_TIMEOUT_MS: String(attemptMs),
        VERDA_WAKE_POLL_INTERVAL_MS: '100',
      },
      () =>
        app.runTurnOverSse({
          sessionId,
          message: 'How many nodes are in the graph?',
          agentId: 'search',
        }),
    )
    const elapsed = Date.now() - started

    expect(status).toBe(200)
    expect(
      frames.some((f) => f.event === 'error'),
      'the turn failed even though a later attempt found the box up',
    ).toBe(false)
    expect(frames.some((f) => f.event === 'done')).toBe(true)
    // It waited out the abandoned attempt rather than skipping it.
    expect(
      elapsed,
      `the turn finished in ${elapsed}ms, faster than one abandoned attempt`,
    ).toBeGreaterThanOrEqual(attemptMs)
    // ABANDONING A REQUEST DOES NOT UNSEND IT. The fake is still holding the
    // first attempt and only records a call once it answers, so the record lands
    // `ms` after it arrived — which is after this turn finished and, without this
    // wait, after the NEXT scenario file's `reset()`, where it showed up as a
    // phantom extra call in whichever file vitest happened to run next (files run
    // sequentially in ONE process and are ordered by size, not by number, so the
    // victim is not even predictable). Waiting for it here is both the fix and
    // the strongest form of the assertion: BOTH attempts are then visible.
    await new Promise((resolve) => setTimeout(resolve, attemptMs * 3))
    const pings = wakePings(app)
    expect(pings.length, 'the wake did not retry — one attempt is all it made').toBe(2)
    expect(
      pings.some((p) => p.delayedMs === attemptMs * 3),
      'no attempt was withheld, so the fault never armed and this passed for the wrong reason',
    ).toBe(true)
    expect(
      pings.some((p) => p.delayedMs === 0),
      'the only answered wake ping was the withheld one — the poll did not retry',
    ).toBe(true)
  })

  it('is not sent on the anthropic tier, which has no box to start', async () => {
    await app.setTier('anthropic')
    const sessionId = newSessionId('coldux-anthropic')
    // Armed and filtered to the Verda model, so it cannot fire here — if the
    // notice appeared anyway it would be reading the tier, not the box.
    goCold(app)

    const { status, frames } = await app.runTurnOverSse({
      sessionId,
      message: 'How many nodes are in the graph?',
      agentId: 'search',
    })

    expect(status).toBe(200)
    expect(frames.some((f) => f.event === 'done')).toBe(true)
    expect(
      frames.filter((f) => f.event === 'warming'),
      'the anthropic tier was told the GPU was starting',
    ).toEqual([])
    // And it sent no wake ping. A metered always-on API has no box to start, so a
    // ping here would be a request to a deployment this turn is not using — and,
    // on the private tier's endpoint, one that would WAKE and start billing a GPU
    // for a turn that never touches it.
    expect(wakePings(app), 'the anthropic tier woke the GPU box').toEqual([])
  })
})
