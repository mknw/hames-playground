/**
 * LiveProgressBar — the in-chat progress readout's timing and fill maths.
 *
 * Two behaviours carry the whole design and neither is visible from the
 * markup alone:
 *
 *  - the 350ms mount delay, which is what keeps a direct router reply (well
 *    under a second) from flashing a progress bar at the user;
 *  - the fill, which scales `currentTurn` through the *refined* path
 *    projection while keeping the stable max as the bar's denominator, so a
 *    route that turns out shorter than the worst case still fills smoothly.
 *
 * The delays are real (not faked): the component drives them with
 * setTimeout + requestAnimationFrame, and a fake-timer harness that stubbed
 * only one of the two would test the harness rather than the component.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { render } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import { installDomObservers } from '../../mocks/dom-observers'
import { LiveProgressBar } from '~/components/ark-ui/LiveProgressBar'

beforeAll(installDomObservers)

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** Past MOUNT_DELAY_MS (350) / EXIT_FADE_MS (360) with room to spare. */
const pastDelay = () => wait(450)

const bar = (root: HTMLElement) => root.querySelector<HTMLElement>('[data-progress]')
const range = (root: HTMLElement) => root.querySelector<HTMLElement>('[data-part="range"]')!
const labels = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>('[data-part="label"]')].map((l) => l.textContent)

const props = (over: Partial<Parameters<typeof LiveProgressBar>[0]> = {}) => ({
  status: 'Querying Neo4j',
  current: 0,
  pathProjection: 0,
  maxProjection: 8,
  visible: true,
  ...over,
})

describe('LiveProgressBar — mount delay', () => {
  it('stays hidden for a chain that finishes inside the mount delay', async () => {
    const [visible, setVisible] = createSignal(true)
    const { container } = render(() => <LiveProgressBar {...props({ visible: visible() })} />)

    // A direct router reply: done in ~150ms, well before the bar would appear.
    await wait(150)
    // Asserted *while the chain is still running*: after the exit fade the bar
    // is absent whether or not it ever flashed, so only this checkpoint
    // distinguishes "never appeared" from "appeared and left again".
    expect(bar(container), 'no flash while a sub-350ms chain is in flight').toBeNull()

    setVisible(false)
    await pastDelay()

    expect(bar(container)).toBeNull()
  })

  it('appears once the chain has been running past the delay', async () => {
    const { container } = render(() => <LiveProgressBar {...props()} />)
    expect(bar(container), 'nothing at t=0').toBeNull()

    await pastDelay()
    expect(bar(container)).toBeTruthy()
  })

  it('fades out and unmounts when the run ends', async () => {
    const [visible, setVisible] = createSignal(true)
    const { container } = render(() => <LiveProgressBar {...props({ visible: visible() })} />)
    await pastDelay()
    expect(bar(container)).toBeTruthy()

    setVisible(false)
    // Mid-exit the element is still there, just transitioning to opacity 0.
    await wait(60)
    expect(bar(container)!.style.opacity).toBe('0')

    await pastDelay()
    expect(bar(container)).toBeNull()
  })
})

describe('LiveProgressBar — status line', () => {
  it('shows the current status', async () => {
    const { container } = render(() => <LiveProgressBar {...props()} />)
    await pastDelay()
    expect(labels(container)).toContain('Querying Neo4j')
  })

  it('crossfades the outgoing status alongside the new one, then drops it', async () => {
    const [status, setStatus] = createSignal<string | null>('Querying Neo4j')
    const { container } = render(() => <LiveProgressBar {...props({ status: status() })} />)
    await pastDelay()

    setStatus('Synthesising answer')
    // Both are on screen during the 220ms crossfade.
    expect(labels(container)).toEqual(
      expect.arrayContaining(['Querying Neo4j', 'Synthesising answer']),
    )

    await wait(300)
    expect(labels(container)).toEqual(['Synthesising answer'])
  })

  it('reserves the status row with a hard space when there is no status yet', async () => {
    const { container } = render(() => <LiveProgressBar {...props({ status: null })} />)
    await pastDelay()
    //   keeps the row's height so the bar doesn't jump when text lands.
    expect(labels(container)).toEqual([' '])
  })
})

describe('LiveProgressBar — fill', () => {
  const widthOf = (root: HTMLElement) => range(root).style.width

  it('scales the fill by the refined path projection, not the stable max', async () => {
    // Worst case was 8 turns; the chosen route needs 4. Turn 1 of 4 is 25%.
    const { container } = render(() => (
      <LiveProgressBar {...props({ current: 1, pathProjection: 4, maxProjection: 8 })} />
    ))
    await pastDelay()
    expect(widthOf(container)).toBe('25%')
  })

  it('falls back to the max projection before the path is refined', async () => {
    const { container } = render(() => (
      <LiveProgressBar {...props({ current: 2, pathProjection: 0, maxProjection: 8 })} />
    ))
    await pastDelay()
    expect(widthOf(container)).toBe('25%')
  })

  it('clamps at 100% when the run overruns its projection', async () => {
    const { container } = render(() => (
      <LiveProgressBar {...props({ current: 99, pathProjection: 4, maxProjection: 4 })} />
    ))
    await pastDelay()
    expect(widthOf(container)).toBe('100%')
  })

  // Rather than freezing mid-fill on the way out, the bar completes — the
  // exit animation then carries a *finished* bar off screen.
  it('fills to 100% as the run ends', async () => {
    const [visible, setVisible] = createSignal(true)
    const { container } = render(() => (
      <LiveProgressBar
        {...props({ current: 1, pathProjection: 8, maxProjection: 8, visible: visible() })}
      />
    ))
    await pastDelay()
    expect(widthOf(container)).not.toBe('100%')

    setVisible(false)
    await wait(60)
    expect(widthOf(container)).toBe('100%')
  })

  // maxProjection can legitimately be 0 before the estimate is seeded; a 0
  // denominator must not produce NaN%.
  it('never divides by a zero projection', async () => {
    const { container } = render(() => (
      <LiveProgressBar {...props({ current: 0, pathProjection: 0, maxProjection: 0 })} />
    ))
    await pastDelay()
    expect(widthOf(container)).toBe('0%')
  })
})

// ---------------------------------------------------------------------------
// The cold-start notice (D-c)
// ---------------------------------------------------------------------------

/**
 * The warming variant, and the three things about it that a reader cannot
 * check by looking at the markup:
 *
 *  - the PROGRESS BAR is gone while the box is starting. The chain's
 *    denominator is seeded by the turn's first event, so the bar is already
 *    projectable during a cold start and would sit at 0/N for the whole 146s —
 *    which reads as a hung chat, not as a wait. That suppression is the point
 *    of the feature, so it is the first thing pinned.
 *  - the SHELL does not resize when the notice gives way to the bar. Both
 *    variants render inside a column reserving the same `min-h`, so the
 *    trailing slot does not shift the transcript under the reader.
 *  - the estimate TICKS DOWN and is `aria-hidden`, while the announcement is a
 *    complete phrase that does not change with it. A live region carrying the
 *    countdown would interrupt a screen-reader user once a second for two
 *    minutes.
 */
const notice = (over: Partial<{ estimateMs: number; receivedAt: number }> = {}) => ({
  sessionId: 's1',
  estimateMs: 146_000,
  basis: 'default' as const,
  samples: 0,
  receivedAt: 1_000_000,
  ...over,
})

const coldNotice = (root: HTMLElement) =>
  root.querySelector<HTMLElement>('[data-testid="cold-start-notice"]')
const shell = (root: HTMLElement) =>
  root.querySelector<HTMLElement>('[data-testid="progress-shell"]')
const liveRegion = (root: HTMLElement) => root.querySelector<HTMLElement>('[aria-live="polite"]')

describe('LiveProgressBar — the cold-start notice', () => {
  it('shows the spinner and the estimate, and NO progress bar', async () => {
    const { container } = render(() => (
      <LiveProgressBar {...props({ warming: notice(), now: () => 1_000_000 })} />
    ))
    await pastDelay()

    const box = coldNotice(container)
    expect(box, 'the notice did not render').toBeTruthy()
    expect(box!.textContent).toContain('starting GPU')
    expect(box!.textContent).toContain('estimated time to first token: ~2 min')
    expect(container.querySelector('.cold-start-spin'), 'no spinner glyph').toBeTruthy()
    // The suppression that is the whole point.
    expect(
      container.querySelector('[data-part="range"]'),
      'the progress bar rendered during a cold start',
    ).toBeNull()
  })

  it('gives the bar back the moment the notice clears, in the same box', async () => {
    const [warming, setWarming] = createSignal<ReturnType<typeof notice> | null>(notice())
    const { container } = render(() => (
      <LiveProgressBar {...props({ warming: warming(), now: () => 1_000_000 })} />
    ))
    await pastDelay()

    // Reserved height is the same in both variants, so the swap cannot move
    // the transcript above it. Asserted as the attribute the column carries
    // rather than a computed pixel height: jsdom lays nothing out, and the
    // reservation IS the literal utility (a runtime value would emit no CSS).
    const beforeShell = shell(container)
    expect(beforeShell?.getAttribute('min-h')).toBe('10')

    setWarming(null)
    await wait(50)

    expect(coldNotice(container)).toBeNull()
    expect(container.querySelector('[data-part="range"]'), 'the bar did not come back').toBeTruthy()
    // Same element, same reservation — not a remount into a different box.
    expect(shell(container)?.getAttribute('min-h')).toBe('10')
    expect(shell(container)).toBe(beforeShell)
  })

  it('counts the estimate down against the browser’s own clock', async () => {
    const [now, setNow] = createSignal(1_000_000)
    const { container } = render(() => (
      <LiveProgressBar {...props({ warming: notice({ receivedAt: 1_000_000 }), now: now })} />
    ))
    await pastDelay()
    expect(coldNotice(container)!.textContent).toContain('~2 min')

    // 100s in: ~46s left, rounded up to fifty.
    setNow(1_100_000)
    await wait(1100)
    expect(coldNotice(container)!.textContent).toContain('~50 sec')

    // Past the estimate it stops counting rather than showing zero.
    setNow(1_300_000)
    await wait(1100)
    const text = coldNotice(container)!.textContent!
    expect(text).toContain('longer than the usual ~2 min')
    expect(text).not.toContain('~0 sec')
  })

  it('announces one complete phrase, and hides the ticking figure from it', async () => {
    const { container } = render(() => (
      <LiveProgressBar {...props({ warming: notice(), now: () => 1_000_000 })} />
    ))
    await pastDelay()

    const live = liveRegion(container)
    expect(live?.textContent).toBe(
      'Waiting for the self-hosted model to start. Estimated time to first token: about 2 min.',
    )
    // Everything that ticks is aria-hidden, so the region above is the only
    // thing announced and it does not change while the wait runs.
    const ticking = [...container.querySelectorAll<HTMLElement>('[aria-hidden="true"]')]
      .map((n) => n.textContent ?? '')
      .join(' ')
    expect(ticking).toContain('estimated time to first token')
  })

  it('says where the estimate came from, without dressing a fallback as a reading', async () => {
    const { container } = render(() => (
      <LiveProgressBar
        {...props({
          warming: { ...notice(), basis: 'measured' as const, samples: 3 },
          now: () => 1_000_000,
        })}
      />
    ))
    await pastDelay()

    const hint = [...container.querySelectorAll<HTMLElement>('[title]')]
      .map((n) => n.getAttribute('title'))
      .join(' ')
    expect(hint).toContain('3 most recent cold starts')
  })
})
