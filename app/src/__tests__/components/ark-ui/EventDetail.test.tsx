import { cleanup, render } from '@solidjs/testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import type { ContextEvent, DecisionMadeEventData } from '@hames-ai/harness-patterns'
import { EventDetailPanel } from '~/components/ark-ui/observability/EventDetail'
import { EventRow } from '~/components/ark-ui/observability/TimelineRows'

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
  label: 'now',
  top: 'soon',
  expected: 1.43,
  value: 2,
  margin: 0.14,
  confidence: 0.355,
  abstained: true,
  reason: 'low-confidence',
  policy: { fallback: 'now', minConfidence: 0.6 },
  method: 'logprob',
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
  it('draws the score mean at expected, independently of mode and fallback', () => {
    const panel = detail()
    expect(panel.querySelector<HTMLElement>('[data-role="decision-mean"]')!.style.left).toBe(
      '71.5%',
    )
    const meter = panel.querySelector('[aria-label="Score mean (level index)"]')!
    expect(meter.getAttribute('aria-valuenow')).toBe('1.43')
    expect(meter.getAttribute('aria-valuemax')).toBe('2')
    expect(panel.textContent).toContain('Mean (level index): 1.43')
    expect(panel.querySelector('[data-role="decision-verdict"]')!.textContent).toContain('now')
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
  it.each([null, undefined])('does not invent a score mean when %s', (expected) => {
    const panel = detail({ expected })
    expect(panel.querySelector('[data-role="decision-mean"]')).toBeNull()
    expect(panel.textContent).toContain('Mean (level index): unknown')
    expect(panel.querySelectorAll('[data-role="decision-label"]')).toHaveLength(3)
  })
  // Mutation: draw the band at .5 regardless of minConfidence.
  it.each([0, 0.4, 0.6, 1])('noul band follows declared minConfidence %s', (c) => {
    const panel = detail({
      type: 'noul',
      pTrue: 0.7,
      label: 'false',
      top: 'true',
      expected: undefined,
      labels: [
        { id: 'true', description: 'Holds' },
        { id: 'false', description: 'Does not hold' },
      ],
      probs: { true: 0.7, false: 0.3 },
      policy: { fallback: 'false', minConfidence: c },
    })
    const band = panel.querySelector<HTMLElement>('[data-role="decision-band"]')!
    expect(band).not.toBeNull()
    expect(parseFloat(band.style.left)).toBeCloseTo((1 - c) * 50)
    expect(parseFloat(band.style.width)).toBeCloseTo(c * 100)
    expect(parseFloat(band.style.left) + parseFloat(band.style.width)).toBeCloseTo((1 + c) * 50)
    expect(panel.querySelector('[aria-label="P(true)"]')!.getAttribute('aria-valuenow')).toBe('0.7')
    expect(panel.querySelectorAll('[data-role="decision-bar"]')).toHaveLength(1)
    expect(panel.querySelector<HTMLElement>('[data-role="decision-bar"]')!.style.width).toBe('70%')
    expect(panel.querySelector('[data-role="decision-cut"]')).toBeNull()
    expect(panel.textContent).toContain('edges accepted')
    expect(panel.textContent).not.toContain('margin')
  })
  it('shows unknown noul readouts without a false zero', () => {
    const panel = detail({ type: 'noul', pTrue: null, policy: { fallback: 'false' } })
    expect(panel.textContent).toContain('P(true): unknown')
    expect(panel.querySelector('[aria-label="P(true)"]')).toBeNull()
    expect(panel.querySelector('[data-role="decision-band"]')).toBeNull()
  })
  it('shows a noul with no declared cut without inventing a band', () => {
    const panel = detail({ type: 'noul', pTrue: 0.9, policy: { fallback: 'false' } })
    expect(panel.querySelector('[data-role="decision-band"]')).toBeNull()
    expect(panel.querySelector<HTMLElement>('[data-role="decision-bar"]')!.style.width).toBe('90%')
  })
  it('preserves persisted choice bars and cuts when new fields are absent', () => {
    const panel = detail({
      type: undefined,
      expected: undefined,
      value: undefined,
      pTrue: undefined,
    })
    expect(panel.querySelectorAll('[data-role="decision-bar"]')).toHaveLength(3)
    expect(panel.querySelectorAll('[data-role="decision-cut"]')).toHaveLength(3)
    expect(panel.querySelector('[data-role="decision-mean"]')).toBeNull()
    expect(panel.querySelector('[data-role="decision-band"]')).toBeNull()
    expect(panel.textContent).toContain('margin')
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
