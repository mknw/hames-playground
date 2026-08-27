/**
 * AppLoadingSplash — what the app shows instead of a white screen (#295).
 *
 * The claim that matters is that this thing renders SOMETHING the moment it is
 * mounted, with no data, no resource and no network: it is the fallback for two
 * boundaries, and a fallback that needs anything to arrive before it paints is
 * not a fallback. Everything else here is the visible half of the arithmetic
 * pinned in `lib/splash-progress.test.ts`.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { render } from '@solidjs/testing-library'
import { installDomObservers } from '../../mocks/dom-observers'
import {
  resetSplashClock,
  SPLASH_LINES,
  SPLASH_LINE_MS,
  SPLASH_TICK_MS,
} from '~/lib/splash-progress'

beforeAll(installDomObservers)
beforeEach(resetSplashClock)

const { AppLoadingSplash, SPLASH_ANNOUNCEMENT } =
  await import('~/components/ark-ui/AppLoadingSplash')

/**
 * Long enough for the component's own `setInterval` to fire.
 *
 * The elapsed CLOCK is injectable and the tests drive it, but the interval that
 * re-reads it runs on real time — so advancing the fake clock only reaches the
 * DOM after a real tick has elapsed. Waiting less than one made the first
 * version of the two progression tests assert against the frame they had
 * already checked.
 */
const tick = () => new Promise((r) => setTimeout(r, SPLASH_TICK_MS + 60))

/** A clock the test drives, so the rotation is exercised without waiting for it. */
const fakeClock = (start = 1_000_000) => {
  let t = start
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

describe('AppLoadingSplash', () => {
  it('paints a bar and a status line with no data at all', () => {
    const { container, getByTestId } = render(() => <AppLoadingSplash />)
    expect(getByTestId('app-loading-splash')).toBeTruthy()
    expect(container.querySelector('[data-testid="splash-progress-track"]')).toBeTruthy()
    expect(getByTestId('splash-line').textContent).toBe(SPLASH_LINES[0])
  })

  it('announces one stable phrase rather than the rotating line', () => {
    // A live region carrying text that changes every 1.8s interrupts a listener
    // on every change — the same decision the cold-start notice records.
    const { container } = render(() => <AppLoadingSplash />)
    const live = container.querySelector('[aria-live="polite"]')
    expect(live?.textContent).toBe(SPLASH_ANNOUNCEMENT)

    // The visual half is decorative and hidden from the accessibility tree.
    const line = container.querySelector('[data-testid="splash-line"]')
    expect(line?.closest('[aria-hidden="true"]')).toBeTruthy()
  })

  it('rotates the status line as the wait goes on', async () => {
    const clock = fakeClock()
    const { getByTestId } = render(() => <AppLoadingSplash now={clock.now} />)
    await tick()
    expect(getByTestId('splash-line').textContent).toBe(SPLASH_LINES[0])

    clock.advance(SPLASH_LINE_MS + 50)
    await tick()
    expect(getByTestId('splash-line').textContent).toBe(SPLASH_LINES[1])

    clock.advance(SPLASH_LINE_MS)
    await tick()
    expect(getByTestId('splash-line').textContent).toBe(SPLASH_LINES[2])
  })

  it('advances the bar as the wait goes on, and never reaches 100%', async () => {
    const clock = fakeClock()
    const { container } = render(() => <AppLoadingSplash now={clock.now} />)
    const width = () => {
      const style = container.querySelector('[data-part="range"]')?.getAttribute('style') ?? ''
      return Number.parseFloat(/width:\s*([\d.]+)%/.exec(style)?.[1] ?? '-1')
    }
    await tick()
    const first = width()
    expect(first).toBeGreaterThan(0)

    clock.advance(2_000)
    await tick()
    expect(width()).toBeGreaterThan(first)

    // The honesty constraint, from the rendered DOM rather than from the maths:
    // a bar sitting at 100% in front of a screen that has not changed reads as
    // a hung app.
    clock.advance(10 * 60_000)
    await tick()
    expect(width()).toBeLessThan(100)
  })

  it('does not restart the bar when it is remounted mid-wait', async () => {
    // The two gates hand over: `AuthProvider`'s `<Show>` unmounts this and
    // `app.tsx`'s `<Suspense>` mounts it again in the same tick. A per-mount
    // clock would walk the bar backwards in the middle of one wait — a smaller
    // version of the complaint this component exists to fix.
    const clock = fakeClock()
    const first = render(() => <AppLoadingSplash now={clock.now} />)
    await tick()
    clock.advance(2_000)
    await tick()
    const before = first.container.querySelector('[data-part="range"]')?.getAttribute('style') ?? ''
    const beforeWidth = Number.parseFloat(/width:\s*([\d.]+)%/.exec(before)?.[1] ?? '-1')
    first.unmount()

    // Remounted a couple of frames later, well inside the continuity gap.
    clock.advance(30)
    const second = render(() => <AppLoadingSplash now={clock.now} />)
    await tick()
    const after = second.container.querySelector('[data-part="range"]')?.getAttribute('style') ?? ''
    const afterWidth = Number.parseFloat(/width:\s*([\d.]+)%/.exec(after)?.[1] ?? '-1')

    expect(afterWidth).toBeGreaterThanOrEqual(beforeWidth)
  })
})
