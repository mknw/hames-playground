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
