import { cleanup, render } from '@solidjs/testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import type { ContextEvent, DecisionMadeEventData } from '@hames-ai/harness-patterns'
import { EventDetailPanel } from '~/components/ark-ui/observability/EventDetail'
import { EventRow } from '~/components/ark-ui/observability/TimelineRows'
import { createGenerator } from 'unocss'
import config from '../../../../uno.config'

afterEach(cleanup)
const data: DecisionMadeEventData = {
  key: 'eval.score',
  question: 'How urgent is a reply?',
  type: 'score',
  labels: [
    { id: 'wait', description: 'Nothing is blocked.' },
    { id: 'soon', description: 'Someone is waiting.' },
    { id: 'now', description: 'Work is blocked.' },
  ],
  probs: { wait: 0, soon: 0.57, now: 0.43 },
  label: 'soon',
  top: 'soon',
  expected: 1.43,
  value: 1,
  margin: 0.14,
  confidence: 0.355,
  abstained: false,
  method: 'jev',
  calibrated: true,
  stateChars: 32,
}
const event = (over: Partial<DecisionMadeEventData> = {}): ContextEvent => ({
  id: 'decision',
  ts: Date.now(),
  type: 'decision_made',
  patternId: 'triage',
  data: { ...data, ...over },
})
const detail = (over: Partial<DecisionMadeEventData> = {}) =>
  render(() => <EventDetailPanel event={event(over)} onClose={() => {}} />).container

describe('EventDetail score/noul observability', () => {
  // Mutation: draw at the mode instead of expected.
  it('draws the score mean at expected, independently of the mode', () => {
    const panel = detail()
    expect(panel.querySelector<HTMLElement>('[data-role="decision-mean"]')!.style.left).toBe(
      '71.5%',
    )
    const meter = panel.querySelector('[aria-label="Score mean (level index)"]')!
    expect(meter.hasAttribute('relative')).toBe(true)
    const marker = panel.querySelector('[data-role="decision-mean"]')!
    expect(marker.parentElement).toBe(meter)
    expect(marker.hasAttribute('absolute')).toBe(true)
    expect(marker.getAttribute('inset-y')).toBe('0')
    expect(meter.getAttribute('aria-valuenow')).toBe('1.43')
    expect(meter.getAttribute('aria-valuemax')).toBe('2')
    expect(panel.textContent).toContain('Mean (level index): 1.43')
    expect(panel.querySelector('[data-role="decision-verdict"]')!.textContent).toContain('soon')
    expect(
      [...panel.querySelectorAll<HTMLElement>('[data-role="decision-bar"]')].map(
        (b) => b.style.width,
      ),
    ).toEqual(['0%', '57%', '43%'])
    expect(panel.querySelector('[data-role="decision-cut"]')).toBeNull()
    expect(panel.textContent).not.toContain('margin')
  })
  it.each([0, 2])('places the mean at scale endpoint %s', (expected) => {
    expect(
      detail({ expected }).querySelector<HTMLElement>('[data-role="decision-mean"]')!.style.left,
    ).toBe(`${expected * 50}%`)
  })
  it.each([null, undefined, NaN, Infinity, -Infinity])(
    'does not invent a score mean when %s',
    (expected) => {
      const panel = detail({ expected })
      expect(panel.querySelector('[data-role="decision-mean"]')).toBeNull()
      expect(panel.querySelector('[aria-label="Score mean (level index)"]')).toBeNull()
      expect(panel.textContent).toContain('Mean (level index): unknown')
      expect(panel.querySelectorAll('[data-role="decision-label"]')).toHaveLength(3)
    },
  )
  it.each([null, undefined, NaN, Infinity, -Infinity])(
    'shows unknown noul readouts without a false zero for %s',
    (pTrue) => {
      const panel = detail({ type: 'noul', pTrue })
      expect(panel.textContent).toContain('P(true): unknown')
      expect(panel.querySelector('[aria-label="P(true)"]')).toBeNull()
      expect(panel.querySelector('[data-role="decision-band"]')).toBeNull()
    },
  )
  it.each([NaN, Infinity, -Infinity])('shows unknown nonfinite score probability %s', (p) => {
    const panel = detail({ probs: { wait: p, soon: 0.57, now: 0.43 } })
    const row = panel.querySelector('[data-label="wait"]')!
    expect(row.textContent).toContain('unknown')
    expect(row.querySelector('[role="meter"]')).toBeNull()
    expect(row.querySelector('[data-role="decision-bar"]')).toBeNull()
    expect(panel.querySelectorAll('[data-role="decision-bar"]')).toHaveLength(2)
    expect(
      panel.querySelector('[data-label="soon"] [role="meter"]')!.getAttribute('aria-valuenow'),
    ).toBe('0.57')
  })
  it('keeps absent score probabilities at zero and single-level means without a marker', () => {
    const panel = detail({
      labels: [{ id: 'wait', description: 'Only level' }],
      probs: {},
      expected: 0,
    })
    expect(panel.textContent).toContain('Mean (level index): 0.00')
    expect(panel.querySelector('[data-role="decision-mean"]')).toBeNull()
    expect(
      panel.querySelector('[data-label="wait"] [role="meter"]')!.getAttribute('aria-valuenow'),
    ).toBe('0')
    expect(panel.querySelector<HTMLElement>('[data-role="decision-bar"]')!.style.width).toBe('0%')
  })
  it.each(['score', 'noul'] as const)('pins %s readout contrast in both themes', async (type) => {
    const panel = detail({ type, pTrue: 0.7 })
    const css = (await (await createGenerator(config as never)).generate(panel.innerHTML)).css
    const surface = (panel.firstElementChild as HTMLElement).style.backgroundColor
    const readout = [...panel.querySelectorAll<HTMLElement>('[text]')].find((el) =>
      el.textContent?.startsWith(type === 'score' ? 'Mean (level index):' : 'P(true):'),
    )!
    expect(readout.getAttribute('text')).toBe('xs ui-text-secondary')
    expect(css).toContain(
      '[text~="ui-text-secondary"]{color:color-mix(in srgb, var(--ui-text-secondary)',
    )
    for (const selector of [':root', ':root\\.light']) {
      const block = new RegExp(`${selector}\\s*\\{([^}]*)\\}`).exec(css)![1]
      const tokens = Object.fromEntries(
        [...block.matchAll(/(--ui-[\w-]+)\s*:\s*(#[\da-f]+);/gi)].map(([, k, v]) => [k, v]),
      )
      const rgb = (hex: string) =>
        hex
          .slice(1)
          .match(/../g)!
          .map((c) => parseInt(c, 16))
      // Resolve the rendered surface; the fixed-surface mutation composites over white.
      const variable = /var\((--ui-[\w-]+)\)/.exec(surface)?.[1]
      const rgba = surface.match(/[\d.]+/g)?.map(Number)
      expect(variable || rgba?.length === 4).toBeTruthy()
      const bg = variable
        ? rgb(tokens[variable])
        : rgba!.slice(0, 3).map((c) => c * rgba![3] + 255 * (1 - rgba![3]))
      const luminance = (channels: number[]) =>
        channels
          .map((c) => {
            const v = c / 255
            return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
          })
          .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0)
      const a = luminance(rgb(tokens['--ui-text-secondary']))
      const b = luminance(bg)
      expect((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), selector).toBeGreaterThanOrEqual(
        4.5,
      )
    }
  })
  it('preserves persisted choice bars when new fields are absent', () => {
    const panel = detail({
      type: undefined,
      expected: undefined,
      value: undefined,
      pTrue: undefined,
    })
    expect(panel.querySelectorAll('[data-role="decision-bar"]')).toHaveLength(3)
    expect(panel.querySelector('[data-role="decision-mean"]')).toBeNull()
    expect(panel.textContent).toContain('margin')
  })
  it('renders the noul probability in a positioned meter', () => {
    const panel = detail({
      type: 'noul',
      pTrue: 0.7,
      label: 'true',
      top: 'true',
      probs: { true: 0.7, false: 0.3 },
      labels: [
        { id: 'true', description: 'It holds.' },
        { id: 'false', description: 'It does not.' },
      ],
      margin: 0,
      expected: undefined,
      value: undefined,
    })
    const meter = panel.querySelector('[aria-label="P(true)"]')!
    expect(meter.hasAttribute('relative')).toBe(true)
    expect(panel.querySelector<HTMLElement>('[data-role="decision-bar"]')!.style.width).toBe('70%')
  })
  // Mutation: hard-code the chip to choice.
  it.each(['score', 'noul', undefined] as const)(
    'preview chip names %s (absence means choice)',
    (type) => {
      const { container } = render(() => (
        <EventRow event={event({ type })} index={0} expanded={false} onExpand={() => {}} />
      ))
      expect(container.querySelector('[data-role="decision-type"]')!.textContent).toBe(
        type ?? 'choice',
      )
    },
  )
})
