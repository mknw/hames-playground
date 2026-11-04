/**
 * The browser half of keep-warm-while-open: WHEN it asks, never whether to wake.
 *
 * A fake document stands in for visibility, so each case drives "opened",
 * "hidden", "shown again" and "closed" directly. The server answer is a stub;
 * the decision to wake is `keep-warm-while-open.test.ts`'s subject.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startKeepWarm } from '../../lib/private-tier-keep-warm'
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
const warm: KeepWarmAnswer = { enabled: true, warmed: true, nextInMs: NEXT }
let doc: FakeDoc
let ask: ReturnType<typeof vi.fn<() => Promise<KeepWarmAnswer>>>
let stop: () => void = () => {}

const start = (onWarmed?: () => void) => {
  stop = startKeepWarm({ ask, onWarmed, doc: doc as unknown as Document })
}

beforeEach(() => {
  vi.useFakeTimers()
  doc = new FakeDoc()
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
    ask.mockResolvedValue({ enabled: false, warmed: false, nextInMs: null })
    start()
    await vi.advanceTimersByTimeAsync(NEXT * 5)
    doc.set('hidden')
    doc.set('visible')
    await vi.advanceTimersByTimeAsync(NEXT * 5)
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('keeps asking on the Anthropic tier, so a switch back to private is noticed', async () => {
    ask.mockResolvedValue({ enabled: true, warmed: false, nextInMs: NEXT })
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

  it('stops entirely once disposed — the page closed', async () => {
    start()
    await vi.advanceTimersByTimeAsync(0)
    stop()
    doc.set('hidden')
    doc.set('visible')
    await vi.advanceTimersByTimeAsync(NEXT * 5)
    expect(ask).toHaveBeenCalledTimes(1)
  })
})
