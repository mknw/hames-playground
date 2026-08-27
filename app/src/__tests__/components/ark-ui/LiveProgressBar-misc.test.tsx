/**
 * LiveProgressBar — the mount delay, the exit transition, and the bar maths.
 *
 * The delay is the whole point of the component: a direct router reply must
 * finish before the bar ever appears. Fake timers let that be asserted rather
 * than slept through. The fill is checked through `Progress.Root`'s ARIA
 * value, which is the same number the width is derived from.
 *
 * Since #295 that value is a PERCENTAGE. The bar itself moved to the shared
 * `ProgressBar`, whose one prop is `percent`, so `aria-valuenow` is now 0..100
 * rather than the chain's own 0..maxProjection turn scale. The fill is
 * unchanged — `percent()` in the component is the same expression it always
 * was, and every figure below is the old one expressed on the new base — but
 * the assertions have to name the base they read.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { createSignal } from 'solid-js'
import { installDomStubs } from './dom-stubs'

beforeAll(() => installDomStubs())

const { render } = await import('@solidjs/testing-library')
const { LiveProgressBar } = await import('../../../components/ark-ui/LiveProgressBar')

const MOUNT_DELAY_MS = 350
const EXIT_FADE_MS = 360

const bar = (root: HTMLElement) => root.querySelector<HTMLElement>('[data-progress]')
/** The fill, as a percentage string — see the header for why it is not turns. */
const fillPercent = (root: HTMLElement) =>
  root.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')

beforeEach(() => {
  vi.useFakeTimers()
  // The entry animation is scheduled on a frame; run it as a macrotask so the
  // fake clock drives it.
  vi.stubGlobal(
    'requestAnimationFrame',
    (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number,
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('LiveProgressBar', () => {
  it('stays hidden for a chain that finishes inside the mount delay', () => {
    const [visible, setVisible] = createSignal(true)
    const { container } = render(() => (
      <LiveProgressBar
        status="Routing…"
        current={0}
        pathProjection={4}
        maxProjection={8}
        visible={visible()}
      />
    ))

    vi.advanceTimersByTime(MOUNT_DELAY_MS - 50)
    // Checked before the chain ends: past the exit fade the bar is gone either
    // way, so the post-teardown assertion below cannot tell a bar that never
    // mounted from one that flashed and left.
    expect(bar(container), 'a sub-350ms chain never flashes the bar').toBeNull()

    setVisible(false)
    vi.advanceTimersByTime(1000)

    expect(bar(container), 'and it is still absent once the chain ends').toBeNull()
  })

  it('appears once the chain outlives the mount delay', () => {
    const { container } = render(() => (
      <LiveProgressBar
        status="Querying Neo4j"
        current={1}
        pathProjection={4}
        maxProjection={8}
        visible
      />
    ))

    expect(bar(container)).toBeNull()
    vi.advanceTimersByTime(MOUNT_DELAY_MS + 10)

    expect(bar(container)).toBeTruthy()
    expect(container.textContent).toContain('Querying Neo4j')
  })

  it('scales the fill by the chosen path, not the worst-case denominator', () => {
    const { container } = render(() => (
      <LiveProgressBar status="Working" current={2} pathProjection={4} maxProjection={8} visible />
    ))
    vi.advanceTimersByTime(MOUNT_DELAY_MS + 10)

    // 2 of a 4-step path == half way. Was `'4'` on the old 0..8 turn scale.
    expect(fillPercent(container)).toBe('50')
  })

  it('clamps the fill to the bar maximum when a chain overruns its projection', () => {
    const { container } = render(() => (
      <LiveProgressBar status="Working" current={99} pathProjection={4} maxProjection={8} visible />
    ))
    vi.advanceTimersByTime(MOUNT_DELAY_MS + 10)

    // Was `'8'`, the old scale's own maximum.
    expect(fillPercent(container)).toBe('100')
  })

  it('fills completely once the chain is no longer visible', () => {
    const [visible, setVisible] = createSignal(true)
    const { container } = render(() => (
      <LiveProgressBar
        status="Working"
        current={1}
        pathProjection={4}
        maxProjection={8}
        visible={visible()}
      />
    ))
    vi.advanceTimersByTime(MOUNT_DELAY_MS + 10)
    expect(fillPercent(container)).toBe('25')

    setVisible(false)
    // Still mounted through the exit fade, but topped out.
    expect(fillPercent(container)).toBe('100')
  })

  it('unmounts only after the exit transition has run', () => {
    const [visible, setVisible] = createSignal(true)
    const { container } = render(() => (
      <LiveProgressBar
        status="Working"
        current={1}
        pathProjection={4}
        maxProjection={8}
        visible={visible()}
      />
    ))
    vi.advanceTimersByTime(MOUNT_DELAY_MS + 10)
    expect(bar(container)).toBeTruthy()

    setVisible(false)
    vi.advanceTimersByTime(EXIT_FADE_MS - 50)
    expect(bar(container), 'still fading out').toBeTruthy()

    vi.advanceTimersByTime(100)
    expect(bar(container)).toBeNull()
  })

  it('crossfades the previous status alongside the new one', () => {
    const [status, setStatus] = createSignal<string | null>('Routing…')
    const { container } = render(() => (
      <LiveProgressBar status={status()} current={1} pathProjection={4} maxProjection={8} visible />
    ))
    vi.advanceTimersByTime(MOUNT_DELAY_MS + 10)

    setStatus('Querying Neo4j')
    expect(container.textContent).toContain('Querying Neo4j')
    expect(container.textContent, 'the outgoing label is still in the DOM, fading').toContain(
      'Routing…',
    )

    vi.advanceTimersByTime(300)
    expect(container.textContent).not.toContain('Routing…')
  })

  it('survives a zero projection rather than dividing by it', () => {
    const { container } = render(() => (
      <LiveProgressBar status={null} current={3} pathProjection={0} maxProjection={0} visible />
    ))
    vi.advanceTimersByTime(MOUNT_DELAY_MS + 10)

    // The guard holds: a 0 denominator becomes 1, so the fill is 1/1 rather
    // than NaN. Was `'1'` when the numerator and the base were both turns.
    expect(fillPercent(container)).toBe('100')
  })
})
