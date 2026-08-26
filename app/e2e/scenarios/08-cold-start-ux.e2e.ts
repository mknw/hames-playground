/**
 * Scenario 8 — the user is told the box is starting, while it is starting.
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
  })
})
