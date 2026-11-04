/**
 * The browser half of keep-warm-while-open: WHEN it asks, never whether to wake.
 *
 * A fake document stands in for visibility and a plain EventTarget for the
 * window's input events, so each case drives "opened", "hidden", "shown again",
 * "idle", "touched" and "closed" directly. The server answer is a stub;
 * the decision to wake is `keep-warm-while-open.test.ts`'s subject.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACTIVITY_EVENTS, startKeepWarm } from '../../lib/private-tier-keep-warm'
import type { KeepWarmAnswer } from '../../lib/harness-client/preview-header.server'

class FakeDoc {
  visibilityState: DocumentVisibilityState = 'visible'
  private listeners = new Set<() => void>()
  addEventListener(_type: string, fn: () => void) {
    this.listeners.add(fn)
  }
  removeEventListener(_type: string, fn: () => void) {
    this.listeners.delete(fn)
  }
  set(state: DocumentVisibilityState) {
    this.visibilityState = state
    for (const fn of this.listeners) fn()
  }
}

const NEXT = 100_000
/** The idle cap the stub answers with: three cadences, so the loop asks at 0,
 *  NEXT and 2·NEXT and finds itself idle at 3·NEXT. */
const CAP = 3 * NEXT
const warm: KeepWarmAnswer = { enabled: true, warmed: true, nextInMs: NEXT, idleCapMs: CAP }
let doc: FakeDoc
let activity: EventTarget
let ask: ReturnType<typeof vi.fn<() => Promise<KeepWarmAnswer>>>
let stop: () => void = () => {}

const start = (onWarmed?: () => void) => {
  stop = startKeepWarm({ ask, onWarmed, doc: doc as unknown as Document, activity })
}

beforeEach(() => {
  vi.useFakeTimers()
  doc = new FakeDoc()
  activity = new EventTarget()
  ask = vi.fn(async () => warm)
})
afterEach(() => {
  stop()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('startKeepWarm', () => {
  it('asks at once when a visible page opens — the app-load wake', async () => {
    start()
    await vi.advanceTimersByTimeAsync(0)
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('asks again after nextInMs while the page stays visible, not before', async () => {
    start()
    await vi.advanceTimersByTimeAsync(NEXT - 1)
    expect(ask).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(ask).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(NEXT)
    expect(ask).toHaveBeenCalledTimes(3)
  })

  it('never asks from a page opened hidden', async () => {
    doc.visibilityState = 'hidden'
    start()
    await vi.advanceTimersByTimeAsync(NEXT * 5)
    expect(ask).not.toHaveBeenCalled()
  })

  it('stops while hidden and asks at once when shown again', async () => {
    start()
    await vi.advanceTimersByTimeAsync(0)
    doc.set('hidden')
    await vi.advanceTimersByTimeAsync(NEXT * 5)
    expect(ask).toHaveBeenCalledTimes(1)
    doc.set('visible')
    await vi.advanceTimersByTimeAsync(0)
    expect(ask).toHaveBeenCalledTimes(2)
  })

  it('does not schedule a next ask when the page was hidden during a pending one', async () => {
    let release: (a: KeepWarmAnswer) => void = () => {}
    ask.mockImplementationOnce(() => new Promise((r) => (release = r)))
    start()
    doc.set('hidden')
    release(warm)
    await vi.advanceTimersByTimeAsync(NEXT * 5)
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('never overlaps a pending ask (a cold wake can take minutes)', async () => {
    ask.mockImplementationOnce(() => new Promise(() => {}))
    start()
    doc.set('hidden')
    doc.set('visible')
    await vi.advanceTimersByTimeAsync(NEXT * 5)
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('stops for good when the server says the feature is off', async () => {
    ask.mockResolvedValue({ enabled: false, warmed: false, nextInMs: null, idleCapMs: null })
    start()
    await vi.advanceTimersByTimeAsync(NEXT * 5)
    doc.set('hidden')
    doc.set('visible')
    await vi.advanceTimersByTimeAsync(NEXT * 5)
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('keeps asking on the Anthropic tier, so a switch back to private is noticed', async () => {
    ask.mockResolvedValue({ enabled: true, warmed: false, nextInMs: NEXT, idleCapMs: CAP })
    const onWarmed = vi.fn()
    start(onWarmed)
    await vi.advanceTimersByTimeAsync(NEXT)
    expect(ask).toHaveBeenCalledTimes(2)
    expect(onWarmed).not.toHaveBeenCalled()
  })

  it('reports a warmed answer to the caller', async () => {
    const onWarmed = vi.fn()
    start(onWarmed)
    await vi.advanceTimersByTimeAsync(0)
    expect(onWarmed).toHaveBeenCalledTimes(1)
  })

  it('stops after a failed ask until the page is shown again, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    ask.mockRejectedValueOnce(new Error('the private inference box did not wake'))
    start()
    await vi.advanceTimersByTimeAsync(NEXT * 5)
    expect(ask).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[keep-warm]'), expect.any(Error))
    doc.set('hidden')
    doc.set('visible')
    await vi.advanceTimersByTimeAsync(0)
    expect(ask).toHaveBeenCalledTimes(2)
  })

  it('schedules nothing when the page closed while an ask was still pending', async () => {
    // The strip unmounts during a cold wake that takes minutes; the answer
    // arriving afterwards must not start a timer nobody can clear.
    let release: (a: KeepWarmAnswer) => void = () => {}
    ask.mockImplementationOnce(() => new Promise((r) => (release = r)))
    start()
    stop()
    release(warm)
    await vi.advanceTimersByTimeAsync(NEXT * 5)
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('stops entirely once disposed — the page closed', async () => {
    start()
    await vi.advanceTimersByTimeAsync(0)
    stop()
    doc.set('hidden')
    doc.set('visible')
    await vi.advanceTimersByTimeAsync(NEXT * 5)
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('does not report an ask that skipped every box as warmed', async () => {
    ask.mockResolvedValue({ ...warm, warmed: false })
    const onWarmed = vi.fn()
    start(onWarmed)
    await vi.advanceTimersByTimeAsync(0)
    expect(onWarmed).not.toHaveBeenCalled()
  })
})

describe('the idle cap (PRIVATE_TIER_WARM_IDLE_MINUTES, FRONT 2026-11-04)', () => {
  const touch = (type = 'pointermove') => activity.dispatchEvent(new Event(type))

  it('stops asking once a visible page has had no input for the cap', async () => {
    // The cost bound in `.env.example`: no ask lands later than the cap after
    // the last input, so an abandoned tab keeps the boxes warm for at most the
    // cap plus one scale-down window.
    start()
    await vi.advanceTimersByTimeAsync(CAP - 1)
    expect(ask).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(NEXT * 20)
    expect(ask).toHaveBeenCalledTimes(3)
  })

  it('keeps asking while a person keeps interacting', async () => {
    start()
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(NEXT)
      touch()
    }
    expect(ask).toHaveBeenCalledTimes(11)
  })

  it('the next interaction after the cap asks at once, through the same ask', async () => {
    start()
    await vi.advanceTimersByTimeAsync(NEXT * 20)
    expect(ask).toHaveBeenCalledTimes(3)
    touch('keydown')
    await vi.advanceTimersByTimeAsync(0)
    expect(ask).toHaveBeenCalledTimes(4)
    // and the loop is running again, at the server's cadence
    await vi.advanceTimersByTimeAsync(NEXT)
    expect(ask).toHaveBeenCalledTimes(5)
  })

  it.each(ACTIVITY_EVENTS)('counts %s as an interaction', async (type) => {
    start()
    await vi.advanceTimersByTimeAsync(NEXT * 20)
    touch(type)
    await vi.advanceTimersByTimeAsync(0)
    expect(ask).toHaveBeenCalledTimes(4)
  })

  it('pointer movement while running sends no extra asks', async () => {
    start()
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < 50; i++) touch()
    await vi.advanceTimersByTimeAsync(NEXT - 1)
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('showing the page again after the cap counts as an interaction', async () => {
    start()
    await vi.advanceTimersByTimeAsync(NEXT * 20)
    doc.set('hidden')
    doc.set('visible')
    await vi.advanceTimersByTimeAsync(0)
    expect(ask).toHaveBeenCalledTimes(4)
  })

  it('stops listening for input once disposed', async () => {
    start()
    await vi.advanceTimersByTimeAsync(NEXT * 20)
    const removed = vi.spyOn(activity, 'removeEventListener')
    stop()
    touch('keydown')
    await vi.advanceTimersByTimeAsync(0)
    expect(ask).toHaveBeenCalledTimes(3)
    // Removed, not merely ignored: a closed page must not leave a handler on the
    // window for every pointer move.
    expect(removed.mock.calls.map(([type]) => type).sort()).toEqual([...ACTIVITY_EVENTS].sort())
  })
})
