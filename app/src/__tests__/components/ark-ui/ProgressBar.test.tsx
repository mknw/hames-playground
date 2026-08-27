/**
 * ProgressBar — the app's one linear bar, after #295 folded three copies into
 * it (the in-chat chain bar, the sidebar row strip, and the boot splash).
 *
 * What is worth pinning here is precisely what the three copies used to agree
 * on by coincidence: the geometry, the two fill modes, and the fact that the
 * indeterminate mode is expressed through the Ark primitive rather than around
 * it. A regression in any of those is silent — a bar with the wrong track
 * colour or a missing sweep animation still renders.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { render } from '@solidjs/testing-library'
import { installDomObservers } from '../../mocks/dom-observers'

beforeAll(installDomObservers)

const { ProgressBar, PROGRESS_GRADIENT } = await import('~/components/ark-ui/ProgressBar')

const track = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-part="track"]')
const range = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-part="range"]')

describe('ProgressBar — determinate', () => {
  it('is an accessible progressbar carrying the percentage', () => {
    const { container } = render(() => <ProgressBar percent={43} />)
    const root = container.querySelector('[role="progressbar"]')
    expect(root).toBeTruthy()
    expect(root?.getAttribute('aria-valuenow')).toBe('43')
    expect(root?.getAttribute('aria-valuemin')).toBe('0')
    expect(root?.getAttribute('aria-valuemax')).toBe('100')
  })

  it('fills to exactly the percentage given, with the glow', () => {
    const { container } = render(() => <ProgressBar percent={43} />)
    const style = range(container)?.getAttribute('style') ?? ''
    expect(style).toContain('width: 43%')
    expect(style).toContain('box-shadow')
    // jsdom re-serialises `rgba(0,255,255,.85)` with spaces, so compare with
    // whitespace stripped rather than pinning jsdom's formatting.
    const squash = (v: string) => v.replace(/\s+/g, '')
    expect(squash(style)).toContain(squash(PROGRESS_GRADIENT))
  })

  it('renders 0% and 100% without falling into indeterminate mode', () => {
    // `percent: 0` is a number, not "no value" — a falsy check here would put a
    // just-started determinate bar into the sweeping mode.
    const zero = render(() => <ProgressBar percent={0} />)
    expect(range(zero.container)?.getAttribute('style')).toContain('width: 0%')
    expect(range(zero.container)?.className ?? '').not.toContain('progress-indeterminate')

    const full = render(() => <ProgressBar percent={100} />)
    expect(range(full.container)?.getAttribute('style')).toContain('width: 100%')
  })

  it('draws the track on the theme token, not on a fixed hex', () => {
    // All three original copies hardcoded `rgb(58, 58, 74)`, which IS this
    // token's dark value — so this is byte-identical in dark mode and stops the
    // bar drawing a near-black trough on a white ground in light mode.
    const { container } = render(() => <ProgressBar percent={50} />)
    const style = track(container)?.getAttribute('style') ?? ''
    expect(style).toContain('var(--ui-border-secondary)')
    expect(style).not.toContain('58, 58, 74')
    expect(style).toContain('height: 3px')
  })
})

describe('ProgressBar — indeterminate', () => {
  it('puts the Ark part tree into the indeterminate state', () => {
    // Expressed through the primitive: zag reports the state, so assistive
    // technology gets it without this component asserting anything.
    const { container } = render(() => <ProgressBar percent={null} />)
    const root = container.querySelector('[data-part="root"]')
    expect(root?.getAttribute('data-state')).toBe('indeterminate')
    expect(container.querySelector('[role="progressbar"]')?.hasAttribute('aria-valuenow')).toBe(
      false,
    )
  })

  it('sweeps a segment, and drops the glow while it moves', () => {
    const { container } = render(() => <ProgressBar percent={null} />)
    const el = range(container)
    // The preflight class in `uno.config.ts` carries the keyframes AND the
    // reduced-motion fallback; a rename that misses one of the two consumers
    // leaves a motionless 40% stub.
    expect(el?.className ?? '').toContain('progress-indeterminate')
    const style = el?.getAttribute('style') ?? ''
    expect(style).toContain('width: 40%')
    // A glow on a moving segment smears — the rule, not a prop.
    expect(style).not.toContain('box-shadow')
  })
})

describe('ProgressBar — the label slot', () => {
  it('renders children above the track, inside the Ark root', () => {
    const { container, getByText } = render(() => (
      <ProgressBar percent={10}>
        <span>counting your conversations…</span>
      </ProgressBar>
    ))
    const label = getByText('counting your conversations…')
    expect(label).toBeTruthy()
    // Inside the root is what lets a consumer use `Progress.Label`, which
    // resolves its root from context.
    expect(container.querySelector('[data-part="root"]')?.contains(label)).toBe(true)
  })

  it('exposes the track under a test id when asked', () => {
    const { container } = render(() => <ProgressBar percent={10} trackTestId="probe-track" />)
    expect(container.querySelector('[data-testid="probe-track"]')).toBeTruthy()
  })
})
